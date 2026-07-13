# Owner Tier + Pro Lock Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename plans to `studio|pro|owner`, add the hidden unlimited-credit owner tier (usage still ledger-tracked), lock Pro tools behind pro/owner, surface app_errors in backoffice notifications, and let backoffice grant/revoke plans.

**Architecture:** One vansen SQL migration carries all DB work (constraint, `plan_grants`, signup trigger, charge-fn owner bypass, three backoffice RPCs, seed). Vansen client gains `proActive`/`isOwner` computeds driving the already-scaffolded `proLocked` UI. Backoffice reuses its service-key PostgREST transport for two new RPC calls.

**Tech Stack:** Postgres/Supabase (migration via MCP `apply_migration`), Deno Hono edge fn, Angular 19 signals, Spring Boot 3 + RestClient.

## Global Constraints

- **NEVER commit/branch/push** — the user owns git. Plan has no commit steps by design.
- Angular components: separate `.ts`/`.html`/`.css`; stylesheet classes over inline styles.
- Vansen tests: `npm test` (bare `npx vitest run` falsely fails TestBed specs).
- Vansen build: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use 22.23.1 >/dev/null && npx ng build`
- Enum master is `src/app/core/enums.ts`; `npm run sync-shared` regenerates `supabase/functions/_shared/`; redeploy `api` afterwards (must bundle every `_shared/` file incl. `providers/`).
- Supabase project ref: `bnorhcxhvxydkgvcxjad`.
- Plan strings everywhere: `studio`, `pro`, `owner`. `owner` never appears in vansen public UI copy; plans/pricing pages untouched.
- Backoffice repo: `/Users/user/IdeaProjects/vankode-backoffice` (Spring backend `backend/`, Angular frontend `frontend/`). Same no-commit rule.
- Backoffice frontend: Tailwind utilities, standalone components, signals; no test harness — verify in browser.

---

### Task 1: Vansen migration `0007_owner_tier.sql`

**Files:**
- Create: `supabase/migrations/0007_owner_tier.sql`

**Interfaces:**
- Produces: `plan_grants` table; `subscriptions.plan` check `('studio','pro','owner')`; updated `handle_new_user()`, `fn_charge_and_generate()` (owner bypass), `backoffice_summary()` (+error events); new RPCs `backoffice_set_plan(p_email text, p_plan text)` and `backoffice_owner_usage()` — all service_role-only.

- [ ] **Step 1: Write the migration file**

```sql
-- 0007: plans studio|pro|owner; owner = hidden internal tier, unlimited credits,
-- usage still ledger-tracked. plan_grants pre-provisions plans by email.

-- 1. Plan rename + owner ------------------------------------------------------
update public.subscriptions set plan = 'pro' where plan = 'studio_pro';
alter table public.subscriptions drop constraint subscriptions_plan_check;
alter table public.subscriptions
  add constraint subscriptions_plan_check check (plan in ('studio','pro','owner'));

-- 2. plan_grants: email → plan, applied at signup or immediately by backoffice
create table public.plan_grants (
  email      text primary key,
  plan       text not null check (plan in ('studio','pro','owner')),
  granted_by text not null,
  created_at timestamptz not null default now()
);
alter table public.plan_grants enable row level security; -- deny-all: no policies

-- 3. Signup trigger applies any waiting grant (best-effort: never block signup)
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_plan text;
begin
  insert into public.profiles (id) values (new.id);
  begin
    select plan into v_plan from public.plan_grants where email = lower(new.email);
    if v_plan is not null then
      insert into public.subscriptions (user_id, plan, status, current_period_end)
      values (new.id, v_plan, 'active', null)
      on conflict (user_id) do update
        set plan = excluded.plan, status = 'active',
            current_period_end = null, updated_at = now();
    end if;
  exception when others then
    null; -- a broken grant must never block signup
  end;
  return new;
end $$;

-- 4. Owner bypass: skip the balance gate, keep the charge row (usage tracking)
create or replace function public.fn_charge_and_generate(
  p_user uuid, p_amount numeric, p_type text, p_family_id text, p_note text, p_items jsonb
) returns setof public.generations
language plpgsql security definer set search_path = public as $$
declare
  v_balance numeric;
  v_owner boolean;
  v_item jsonb;
begin
  perform pg_advisory_xact_lock(hashtext(p_user::text));
  select exists (
    select 1 from public.subscriptions
    where user_id = p_user and plan = 'owner' and status = 'active'
  ) into v_owner;
  if not v_owner then
    select coalesce(sum(amount_usd), 0) into v_balance
      from public.ledger_entries where user_id = p_user;
    if v_balance < p_amount then
      raise exception 'insufficient_balance' using errcode = 'P0001';
    end if;
  end if;
  insert into public.ledger_entries (user_id, type, amount_usd, family_id, note)
  values (p_user, p_type, -p_amount, p_family_id, p_note);
  for v_item in select * from jsonb_array_elements(p_items) loop
    return query
      insert into public.generations
        (user_id, kind, family_id, family_name, op, prompt, settings, price_usd, status, media_url, parent_id)
      values (
        p_user,
        v_item->>'kind', v_item->>'familyId', v_item->>'familyName', v_item->>'op',
        v_item->>'prompt', coalesce(v_item->'settings', '{}'::jsonb),
        (v_item->>'priceUsd')::numeric, 'pending', coalesce(v_item->>'mediaUrl', ''),
        nullif(v_item->>'parentId','')::uuid
      ) returning *;
  end loop;
end $$;

-- 5. Backoffice: set/revoke a plan by email --------------------------------
create or replace function public.backoffice_set_plan(p_email text, p_plan text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_email text := lower(trim(p_email));
  v_user uuid;
  v_stripe text;
begin
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    return jsonb_build_object('ok', false, 'error', 'invalid_email');
  end if;
  if p_plan is not null and p_plan not in ('studio','pro','owner') then
    return jsonb_build_object('ok', false, 'error', 'invalid_plan');
  end if;

  select id into v_user from auth.users where lower(email) = v_email;

  if p_plan is null then
    delete from public.plan_grants where email = v_email;
    if v_user is not null then
      delete from public.subscriptions
        where user_id = v_user and stripe_subscription_id is null;
    end if;
    return jsonb_build_object('ok', true, 'applied', v_user is not null);
  end if;

  if v_user is not null then
    select stripe_subscription_id into v_stripe
      from public.subscriptions where user_id = v_user;
    if v_stripe is not null then
      return jsonb_build_object('ok', false, 'error', 'stripe_subscription_exists');
    end if;
    insert into public.subscriptions (user_id, plan, status, current_period_end)
    values (v_user, p_plan, 'active', null)
    on conflict (user_id) do update
      set plan = excluded.plan, status = 'active',
          current_period_end = null, updated_at = now();
  end if;

  insert into public.plan_grants (email, plan, granted_by)
  values (v_email, p_plan, 'backoffice')
  on conflict (email) do update set plan = excluded.plan, granted_by = 'backoffice';

  return jsonb_build_object('ok', true, 'applied', v_user is not null);
end $$;

-- 6. Backoffice: per-owner usage ---------------------------------------------
create or replace function public.backoffice_owner_usage()
returns jsonb language sql security definer set search_path = public as $$
select coalesce(jsonb_agg(jsonb_build_object(
  'userId', s.user_id,
  'email', (select email from auth.users where id = s.user_id),
  'displayName', p.display_name,
  'generations', (select count(*) from generations g where g.user_id = s.user_id),
  'spendUsd', coalesce((select sum(price_usd) from generations g where g.user_id = s.user_id), 0),
  'balanceUsd', coalesce((select sum(amount_usd) from ledger_entries l where l.user_id = s.user_id), 0),
  'daily', (select coalesce(jsonb_agg(jsonb_build_object('day', d.day, 'value', coalesce(g.c, 0)) order by d.day), '[]'::jsonb)
            from (select generate_series(current_date - 29, current_date, interval '1 day')::date as day) d
            left join (select created_at::date as day, count(*) c from generations
                       where user_id = s.user_id and created_at > current_date - 29 group by 1) g using (day))
)), '[]'::jsonb)
from subscriptions s
join profiles p on p.id = s.user_id
where s.plan = 'owner';
$$;

-- 7. backoffice_summary: recent gains app_errors -------------------------------
create or replace function public.backoffice_summary()
returns jsonb language sql security definer set search_path = public as $$
select jsonb_build_object(
  'users', (select count(*) from profiles),
  'users_7d', (select count(*) from profiles where created_at > now() - interval '7 days'),
  'active_subscriptions', (select count(*) from subscriptions where status = 'active'),
  'generations_total', (select count(*) from generations),
  'generations_7d', (select count(*) from generations where created_at > now() - interval '7 days'),
  'failed_jobs_7d', (select count(*) from jobs where error is not null and updated_at > now() - interval '7 days'),
  'gen_cost_usd_30d', coalesce((select sum(price_usd) from generations where created_at > now() - interval '30 days'), 0),
  'daily', (select coalesce(jsonb_agg(jsonb_build_object('day', d.day, 'value', coalesce(g.c, 0)) order by d.day), '[]'::jsonb)
            from (select generate_series(current_date - 29, current_date, interval '1 day')::date as day) d
            left join (select created_at::date as day, count(*) c from generations
                       where created_at > current_date - 29 group by 1) g using (day)),
  'recent', (select coalesce(jsonb_agg(jsonb_build_object('type', t, 'title', title, 'at', at) order by at desc), '[]'::jsonb)
             from (
               (select 'signup' as t, coalesce(display_name, 'New user') as title, created_at as at
                  from profiles order by created_at desc limit 5)
               union all
               (select 'generation', coalesce(family_name, kind) || ' · ' || coalesce(op, 'create'), created_at
                  from generations order by created_at desc limit 5)
               union all
               (select 'subscription', plan || ' — ' || status, coalesce(updated_at, created_at)
                  from subscriptions order by coalesce(updated_at, created_at) desc limit 5)
               union all
               (select 'error', coalesce(code, 'error') || ' · ' || coalesce(route, '?'), created_at
                  from app_errors order by created_at desc limit 5)
             ) ev)
);
$$;

-- 8. Lockdown + seed ------------------------------------------------------------
revoke execute on function public.backoffice_set_plan(text, text) from public, anon, authenticated;
revoke execute on function public.backoffice_owner_usage() from public, anon, authenticated;
grant execute on function public.backoffice_set_plan(text, text) to service_role;
grant execute on function public.backoffice_owner_usage() to service_role;

insert into public.plan_grants (email, plan, granted_by)
values ('fendyhaddad@google.com', 'owner', 'seed')
on conflict (email) do update set plan = 'owner';
```

- [ ] **Step 2: Apply via MCP** — `apply_migration` (name `owner_tier`) on project `bnorhcxhvxydkgvcxjad` with the file's SQL.

- [ ] **Step 3: Verify with `execute_sql`**

```sql
-- constraint: pro/owner accepted, studio_pro rejected
select conname, pg_get_constraintdef(oid) from pg_constraint where conname='subscriptions_plan_check';
select * from plan_grants;
select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and proname in ('backoffice_set_plan','backoffice_owner_usage');
```
Expected: check lists `('studio','pro','owner')`; one seed grant row; both RPCs present.

- [ ] **Step 4: Exercise owner bypass end-to-end (SQL)**

```sql
-- pick any existing test user id :uid
begin;
insert into subscriptions (user_id, plan, status) values (:'uid','owner','active')
  on conflict (user_id) do update set plan='owner', status='active', current_period_end=null;
select fn_charge_and_generate(:'uid', 999.0, 'generation', 'flux', 'bypass test',
  '[{"kind":"image","familyId":"flux","familyName":"FLUX","op":"create","prompt":"t","priceUsd":"999.0"}]'::jsonb);
select sum(amount_usd) from ledger_entries where user_id = :'uid'; -- negative now
rollback;
```
Expected: charge succeeds despite balance < 999; ledger row present inside txn; rollback leaves DB clean.

---

### Task 2: Vansen enums rename + sync

**Files:**
- Modify: `src/app/core/enums.ts:40-44`
- Modify: `src/app/core/enums.spec.ts:21`
- Regenerate: `supabase/functions/_shared/enums.ts` (via `npm run sync-shared`)

**Interfaces:**
- Produces: `SubscriptionPlan = { Studio: 'studio', Pro: 'pro', Owner: 'owner' }` — consumed by Tasks 3–5.

- [ ] **Step 1: Update the enum master**

```ts
export const SubscriptionPlan = {
  Studio: 'studio',
  Pro: 'pro',
  Owner: 'owner',
} as const;
```

- [ ] **Step 2: Update the spec**

```ts
expect(Object.values(SubscriptionPlan).sort()).toEqual(['owner', 'pro', 'studio'].sort());
```

- [ ] **Step 3: Fix any `StudioPro` references** — `rg -n "StudioPro|studio_pro" src supabase libs` must return only migration history (0001) and docs.

- [ ] **Step 4: Sync + test** — `npm run sync-shared` then `npm test`. Expected: PASS incl. drift guard.

---

### Task 3: API — owner checkout guard + redeploy

**Files:**
- Modify: `supabase/functions/api/index.ts:608` (`/billing/checkout` handler top)

**Interfaces:**
- Consumes: `admin` supabase client, `fail(c, …)` helper (both in file).
- Produces: 400 `owner_plan` for owner-plan callers on checkout.

- [ ] **Step 1: Add the guard** — first statements of the `/billing/checkout` handler, before Stripe work:

```ts
const { data: ownSub } = await admin
  .from('subscriptions')
  .select('plan, status')
  .eq('user_id', userId)
  .maybeSingle();
if (ownSub?.plan === 'owner' && ownSub.status === 'active') {
  return fail(c, 400, 'owner_plan', 'Owner accounts have unlimited credits');
}
```

- [ ] **Step 2: Redeploy `api`** via MCP `deploy_edge_function`, bundling every file under `supabase/functions/api` + `supabase/functions/_shared/` including `providers/` (constraint from CLAUDE.md).

- [ ] **Step 3: Smoke check** — `GET /health` 200; `get_logs` for `api` clean of boot errors.

---

### Task 4: ProfileStore `proActive` + Unlimited balance UI

**Files:**
- Modify: `src/app/core/profile/profile-store.ts` (after `studioActive`, line 30)
- Modify: `src/app/shared/profile-menu/profile-menu.ts` / `.html:18-19,38`
- Modify: `src/app/features/settings/settings-page.ts` / `.html:11`
- Modify: `src/app/features/settings/billing-tab/billing-tab.ts` / `.html:13-14`
- Test: existing profile-store spec file (extend) — `ng test`-compatible.

**Interfaces:**
- Produces: `ProfileStore.isOwner: Signal<boolean>`, `ProfileStore.proActive: Signal<boolean>` — consumed by Task 5 and templates here.

- [ ] **Step 1: Add computeds to ProfileStore**

```ts
/** Hidden internal tier — unlimited credits, never surfaced as a plan name. */
readonly isOwner = computed(() => {
  const sub = this.subscriptionSig();
  return !!sub && sub.plan === SubscriptionPlan.Owner && sub.status !== SubscriptionStatus.Expired;
});

/** Pro benefits: pro or owner plan, not expired past its paid period. */
readonly proActive = computed(() => {
  const sub = this.subscriptionSig();
  if (!sub) return false;
  if (sub.plan !== SubscriptionPlan.Pro && sub.plan !== SubscriptionPlan.Owner) return false;
  if (sub.status === SubscriptionStatus.Expired) return false;
  return !sub.currentPeriodEnd || new Date(sub.currentPeriodEnd) > new Date();
});
```
Import `SubscriptionPlan` from `../enums`.

- [ ] **Step 2: Unlimited chip.** Each of the three components exposes `isOwner = this.profileStore.isOwner` (inject already present or add). Template pattern (repeat per site, class names stay per-site):

```html
@if (isOwner()) {
  <span class="bar-balance">Unlimited</span>
} @else {
  <span class="bar-balance" [class.bar-balance-low]="balanceUsd() < 1">
    ${{ balanceUsd() | number: '1.2-2' }}
  </span>
}
```
Apply to: `profile-menu.html` bar chip + menu row, `settings-page.html` `.balance-chip`, `billing-tab.html` `.balance-big`. Billing tab: also hide the top-up CTA block when `isOwner()` (owners cannot check out — Task 3 guard).

- [ ] **Step 3: Tests** — extend the ProfileStore spec: owner sub ⇒ `isOwner`/`proActive`/`studioActive` all true; pro sub w/ future period ⇒ `proActive` true, `isOwner` false; studio ⇒ `proActive` false. Run `npm test`. Expected: PASS.

---

### Task 5: Pro lock pass (right panel)

**Files:**
- Modify: `src/app/features/studio/right-panel/right-panel.ts:53-78,180,204-216`
- Modify: `src/app/features/studio/right-panel/right-panel.html` (AI section, lines ~104-132)

**Interfaces:**
- Consumes: `ProfileStore.proActive` (Task 4).

- [ ] **Step 1: Regroup tools.** Move `dehaze` and `portraitsmooth` entries from `PRO_TOOLS` to the end of `LOCAL_TOOLS` (spec: Studio keeps them — they're pure ops). `PRO_TOOLS` keeps: select, upscale, bgremove, bokeh, enhance, levels, clone, retouch, perspective, liquify, erase.

- [ ] **Step 2: Flip the lock.** Replace `readonly proLocked = signal(false);` with:

```ts
/** Pro tools lock: pro/owner subscribers only. Waits for /profile like `locked`. */
readonly proLocked = computed(() => this.profileStore.loaded() && !this.profileStore.proActive());
```
Update the stale comment above it. (`computed` already imported.)

- [ ] **Step 3: Gate AI tools.** `runAiTool` and `onAiSelection` get a first-line guard: `if (this.proLocked()) return;`. In the HTML AI section, each `.ai-run` button adds `|| proLocked()` to `[disabled]`, swaps the sparkles icon for `lucideLock` when locked, and the section title gains `@if (proLocked()) { <span class="ai-note">· Pro</span> }`.

- [ ] **Step 4: Verify.** `npm test` (right-panel spec if present), then build (Global Constraints command). Browser check via dev server: non-pro user sees lock icons on Pro rail + AI tools; dehaze/portrait smooth usable on Studio.

---

### Task 6: Leaked-password protection

- [ ] **Step 1:** Try enabling via Supabase Management API (`PATCH /v1/projects/{ref}/config/auth` body `{"password_hibp_enabled": true}`) if an access token is available in the environment; otherwise report to user: flip **Auth → Providers → Passwords → "Prevent use of leaked passwords"** in the dashboard. Re-run `get_advisors(security)` — the WARN disappears when enabled.

---

### Task 7: Backoffice backend — plan set + owner usage

**Files:**
- Modify: `~/IdeaProjects/vankode-backoffice/backend/src/main/java/com/vankode/backoffice/vansen/VansenAdminService.java`
- Modify: `~/IdeaProjects/vankode-backoffice/backend/src/main/java/com/vankode/backoffice/vansen/VansenAdminController.java`
- Test: `~/IdeaProjects/vankode-backoffice/backend/src/test/java/com/vankode/backoffice/VansenAdminValidationTest.java`

**Interfaces:**
- Consumes: RPCs from Task 1; existing `postJson(path, body, type)` helper.
- Produces: `POST /api/vansen/admin/plan` `{email, plan|null}` → `{ok, applied?|error?}`; `GET /api/vansen/admin/owner-usage` → `{owners: [...]}`.

- [ ] **Step 1: Service methods** (follow `setSuspended` style; reuse Jackson if the file already maps bodies, else string-build like existing code):

```java
private static final java.util.Set<String> PLANS = java.util.Set.of("studio", "pro", "owner");

public Map<String, Object> setPlan(String email, String plan) {
    if (email == null || !email.matches("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$")) {
        throw new IllegalArgumentException("invalid email");
    }
    if (plan != null && !PLANS.contains(plan)) {
        throw new IllegalArgumentException("invalid plan");
    }
    String body = "{\"p_email\":\"" + email.toLowerCase(Locale.ROOT) + "\",\"p_plan\":"
            + (plan == null ? "null" : "\"" + plan + "\"") + "}";
    Map<String, Object> out = postJson("/rest/v1/rpc/backoffice_set_plan", body, Map.class);
    if (Boolean.FALSE.equals(out.get("ok"))) {
        throw new IllegalStateException(String.valueOf(out.get("error")));
    }
    return out;
}

public Map<String, Object> ownerUsage() {
    Object rows = postJson("/rest/v1/rpc/backoffice_owner_usage", "{}", Object.class);
    return Map.of("owners", rows == null ? List.of() : rows);
}
```

- [ ] **Step 2: Controller endpoints** (inside `VansenAdminController`, after the credit action):

```java
public record PlanRequest(String email, String plan) {}

@PostMapping("/plan")
public Map<String, Object> setPlan(@RequestBody PlanRequest req) {
    return service.setPlan(req.email(), req.plan());
}

@GetMapping("/owner-usage")
public Map<String, Object> ownerUsage() {
    return service.ownerUsage();
}
```

- [ ] **Step 3: Validation test** (mirror existing `VansenAdminValidationTest` style):

```java
@Test
void setPlanRejectsBadEmail() {
    assertThrows(IllegalArgumentException.class, () -> service.setPlan("not-an-email", "owner"));
}

@Test
void setPlanRejectsUnknownPlan() {
    assertThrows(IllegalArgumentException.class, () -> service.setPlan("a@b.co", "mega"));
}
```

- [ ] **Step 4: Build + test** — `cd ~/IdeaProjects/vankode-backoffice/backend && ./mvnw -q test`. Expected: PASS.

---

### Task 8: Backoffice frontend — grant/revoke UI + owner usage + error notifications

**Files:**
- Modify: `~/IdeaProjects/vankode-backoffice/frontend/src/app/core/api/vansen-admin-api.ts`
- Modify: `~/IdeaProjects/vankode-backoffice/frontend/src/app/features/vansen/user/vansen-user-page.ts` / `.html`
- Modify: `~/IdeaProjects/vankode-backoffice/frontend/src/app/features/vansen/vansen-page.ts` / `.html`
- Modify: `~/IdeaProjects/vankode-backoffice/frontend/src/app/shared/shell/right-panel/right-panel.html`

**Interfaces:**
- Consumes: Task 7 endpoints.
- Produces: `VansenAdminApi.setPlan(email: string, plan: string | null)`, `VansenAdminApi.ownerUsage()`, `OwnerUsageRow` interface.

- [ ] **Step 1: API client**

```ts
export interface OwnerUsageRow {
  userId: string;
  email: string;
  displayName: string | null;
  generations: number;
  spendUsd: number;
  balanceUsd: number;
  daily: { day: string; value: number }[];
}

setPlan(email: string, plan: string | null): Promise<{ ok: boolean; applied?: boolean }> {
  return this.post('/plan', { email, plan });
}

ownerUsage(): Promise<{ owners: OwnerUsageRow[] }> {
  return this.get('/owner-usage');
}
```
(Use the file's existing `get`/`post` helpers.)

- [ ] **Step 2: User detail action.** `vansen-user-page`: next to the existing suspend action, add "Grant owner" / "Revoke owner" button (label depends on `u.plan === 'owner'`), `confirm(...)` dialog, then `this.api.setPlan(u.email, u.plan === 'owner' ? null : 'owner')` via the page's existing `run()` wrapper, then reload. Surface thrown errors with the page's existing error affordance (e.g. `stripe_subscription_exists`).

- [ ] **Step 3: Users list badge + email grant.** `vansen-page.html` users table: plan cell already prints `{{ u.plan }}` — add a distinct badge class when `u.plan === 'owner'` (e.g. amber `owner` chip). Above the users table add a one-line grant form: email input + plan select (`studio|pro|owner`) + "Grant" button calling `setPlan(email, plan)` — covers pre-signup grants.

- [ ] **Step 4: Owner usage card.** In `vansen-page` economics section, add an "Owner usage" card: `@for` row per `OwnerUsageRow` → email, generations, `spendUsd | number:'1.2-2'` (label "spend-equiv"), `balanceUsd`. Load in the same `Promise.all` as economics, tolerate failure (`.catch(() => ({owners: []}))`).

- [ ] **Step 5: Error notification styling.** `right-panel.html` notification row: when `event.type === 'error'`, render the source dot / type text in red (Tailwind `text-red-500`). Data flows automatically from Task 1's `backoffice_summary` change.

- [ ] **Step 6: Verify in browser.** Run backoffice dev servers (backend + `ng serve` per repo config), check: grant form, owner badge, user-page action, owner usage card, error notifications appear in right panel.

---

### Task 9: End-to-end verification

- [ ] Vansen: `npm test` + production build both green.
- [ ] SQL: seed grant present; `backoffice_set_plan('tmp+e2e@vankode.com','owner')` then revoke — both `ok:true`.
- [ ] Vansen browser: non-pro account → Pro rail + AI tools locked, dehaze/portrait smooth free, balance chip unchanged; (owner account once one exists → Unlimited chip, no top-up CTA).
- [ ] Backoffice browser: errors page + notifications show error events; owner usage card renders.
- [ ] Report checklist results to user; user commits both repos.
