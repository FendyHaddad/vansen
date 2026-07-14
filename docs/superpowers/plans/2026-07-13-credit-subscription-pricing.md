# Credit-Based Subscription Pricing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the USD pay-as-you-go ledger with a two-tier credit subscription model (Studio $15/1,500 cr, Pro $30/3,750 cr, 60-day $5-off promo, add-on packs, two-bucket ledger, Pro-only video).

**Architecture:** Credits are integer units (1 cr = $0.01 Studio retail). The shared catalog computes per-generation credit costs with one global table `ceil(providerCost/0.60 × 100)`. The ledger gains a `bucket` column (`plan` resets each cycle via `invoice.paid`; `pack` rolls over while subscribed, dies 30 days after lapse). Tier advantage is expressed in credits-per-dollar (Pro gets 1.25×), never in per-job prices.

**Tech Stack:** Angular 20 signals, Supabase Postgres + Edge Functions (Hono, Deno), Stripe TEST mode, vitest.

**Spec:** `docs/superpowers/specs/2026-07-13-credit-subscription-pricing-design.md`

## Global Constraints

- **NEVER run `git commit`, `git branch`, or `git push`.** The user commits personally. Where other plans say "commit", instead tell the user the task is ready to commit.
- Tests: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use 22.23.1 >/dev/null && npm test` (never bare `npx vitest run` — it falsely fails TestBed specs).
- Build check: same nvm preamble + `npx ng build`.
- Angular components: separate `.ts` + `.html` + `.css` files, stylesheet classes over inline styles.
- After any change to `src/app/core/catalog/model-families.ts` or `src/app/core/enums.ts`: run `npm run sync-shared`, then redeploy the `api` Edge Function bundling every `_shared/` file (Task 12).
- Migrations are applied to Supabase project `bnorhcxhvxydkgvcxjad` via MCP `execute_sql`; the SQL file in `supabase/migrations/` is the record.
- Stripe keys/price IDs live ONLY in Supabase Edge Function secrets. Never in the repo.
- Credit economics (fixed by spec): `STUDIO_MARGIN = 0.40`; plan grants Studio 1500 / Pro 3750; Pro purchase rate 1.25×; packs $10/+0%, $25/+5%, $50/+8%, $100/+10%; AI edit tools remove/fill/expand 10 cr, bg 5 cr, upscale 7 cr; promo = $5 off first 2 cycles, first-time subscribers only.

---

### Task 1: Credit math in the shared catalog

**Files:**
- Modify: `src/app/core/catalog/model-families.ts`
- Test: `src/app/core/catalog/model-families.spec.ts`

**Interfaces:**
- Produces: `STUDIO_MARGIN: number`, `PLAN_CREDITS: { studio: 1500; pro: 3750 }`, `PRO_PURCHASE_RATE = 1.25`, `CREDIT_PACKS: { usd: number; bonusPct: number }[]`, `packCredits(usd: number, plan: 'studio' | 'pro'): number`, `creditCost(family: ModelFamily, s: GenerationSettings): number` (per single output, integer), `upscaleCreditCost(): number`, `EditTool.creditCost: number` (replaces `userPriceUsd`).
- Consumers in later tasks: api gateway (via `_shared/model-families.ts` sync), left-panel, tool-options, detail-overlay, pricing-engine, billing-tab, webhook.

- [ ] **Step 1: Write the failing tests**

Replace the pricing describe-blocks in `src/app/core/catalog/model-families.spec.ts` that reference `userPriceUsd`/`upscaleUserPriceUsd`/`PAYG_MARGIN` with:

```ts
import {
  CREDIT_PACKS,
  EDIT_TOOLS,
  MODEL_FAMILIES,
  PLAN_CREDITS,
  STUDIO_MARGIN,
  creditCost,
  defaultSettings,
  familyById,
  packCredits,
  upscaleCreditCost,
} from './model-families';

describe('credit pricing', () => {
  it('uses a 40% studio margin and 1500/3750 grants', () => {
    expect(STUDIO_MARGIN).toBe(0.4);
    expect(PLAN_CREDITS.studio).toBe(1500);
    expect(PLAN_CREDITS.pro).toBe(3750);
  });

  it('computes credit cost as ceil(providerCost / 0.6 * 100)', () => {
    const seedream = familyById('seedream')!;
    // provider $0.03 → $0.05 retail → 5 credits
    expect(creditCost(seedream, defaultSettings(seedream))).toBe(5);
    const flux = familyById('flux')!;
    // provider $0.03 (1MP) → 5 credits
    expect(creditCost(flux, defaultSettings(flux))).toBe(5);
  });

  it('always yields a positive integer for every family/default', () => {
    for (const family of MODEL_FAMILIES) {
      const credits = creditCost(family, defaultSettings(family));
      expect(Number.isInteger(credits)).toBe(true);
      expect(credits).toBeGreaterThan(0);
    }
  });

  it('prices AI edit tools at fixed credit costs', () => {
    const byId = Object.fromEntries(EDIT_TOOLS.map((t) => [t.id, t.creditCost]));
    expect(byId).toEqual({ 'edit-remove': 10, 'edit-fill': 10, 'edit-expand': 10, 'edit-bg': 5 });
    expect(upscaleCreditCost()).toBe(7);
  });

  it('computes pack credits with tier rate and size bonus', () => {
    expect(CREDIT_PACKS.map((p) => p.usd)).toEqual([10, 25, 50, 100]);
    expect(packCredits(10, 'studio')).toBe(1000);
    expect(packCredits(25, 'studio')).toBe(2625);
    expect(packCredits(50, 'studio')).toBe(5400);
    expect(packCredits(100, 'studio')).toBe(11000);
    expect(packCredits(10, 'pro')).toBe(1250);
    expect(packCredits(25, 'pro')).toBe(3281);
    expect(packCredits(50, 'pro')).toBe(6750);
    expect(packCredits(100, 'pro')).toBe(13750);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- model-families` (with nvm preamble). Expected: FAIL — `creditCost is not exported`, etc.

- [ ] **Step 3: Implement**

In `src/app/core/catalog/model-families.ts`:

1. Delete `import { PAYG_MARGIN } from '../../features/pricing/model-catalog';`.
2. Add above `MODEL_FAMILIES`:

```ts
/** Margin baked into the credit charge table. 1 credit = $0.01 of Studio retail. */
export const STUDIO_MARGIN = 0.4;

/** Monthly credit grant per subscription plan (owner is unlimited, never granted). */
export const PLAN_CREDITS = { studio: 1500, pro: 3750 } as const;

/** Pro buyers get 25% more credits per dollar — same jobs cost 20% less. */
export const PRO_PURCHASE_RATE = 1.25;

/** Add-on packs: one-time purchases, tier rate × size bonus. Subscriber-only. */
export const CREDIT_PACKS: { usd: number; bonusPct: number }[] = [
  { usd: 10, bonusPct: 0 },
  { usd: 25, bonusPct: 5 },
  { usd: 50, bonusPct: 8 },
  { usd: 100, bonusPct: 10 },
];

export function packCredits(usd: number, plan: 'studio' | 'pro'): number {
  const pack = CREDIT_PACKS.find((p) => p.usd === usd);
  if (!pack) return 0;
  const rate = plan === 'pro' ? PRO_PURCHASE_RATE : 1;
  return Math.floor(usd * 100 * rate * (1 + pack.bonusPct / 100));
}
```

3. Replace the two price functions at the bottom:

```ts
/** Integer credits for one output: ceil(providerCost / (1 − margin) × 100). */
export function creditCost(family: ModelFamily, s: GenerationSettings): number {
  return Math.ceil((family.providerCost(s) / (1 - STUDIO_MARGIN)) * 100);
}

export function upscaleCreditCost(): number {
  return Math.ceil((UPSCALER.providerCost / (1 - STUDIO_MARGIN)) * 100);
}
```

4. In `EditTool`, replace `userPriceUsd: number;` (and its doc comment) with `/** Fixed credit price per use — NOT the margin formula. */ creditCost: number;` and update the four entries: `edit-remove` 10, `edit-fill` 10, `edit-expand` 10, `edit-bg` 5 (keep `providerCost` fields).

- [ ] **Step 4: Fix compile fallout in this module only**

`tool-options.ts`, `left-panel.ts`, api `_shared` copies still reference removed symbols — they are later tasks. Only make `model-families.ts` + its spec self-consistent. Run: `npm test -- model-families`. Expected: PASS.

- [ ] **Step 5: Notify user** task is ready (do not commit).

---

### Task 2: Migration 0008 — credit ledger, buckets, RPCs, video gating

**Files:**
- Create: `supabase/migrations/0008_credit_plans.sql`
- Apply via MCP `execute_sql` against project `bnorhcxhvxydkgvcxjad`.

**Interfaces:**
- Produces RPCs (service_role only): `fn_balances(p_user uuid) returns table(plan_credits int, pack_credits int)`, `fn_charge_and_generate(p_user uuid, p_amount int, p_type text, p_family_id text, p_note text, p_items jsonb)` (items carry `priceCredits`), `fn_cycle_reset(p_user uuid, p_grant int)`, `fn_grant_pack(p_user uuid, p_credits int, p_stripe_ref text)`, `fn_fail_job` (bucket-aware refunds).
- Schema: `ledger_entries.amount_credits int` + `bucket`, `generations.price_credits/charged_plan/charged_pack`, `models.min_plan`.

- [ ] **Step 1: Write the migration file**

```sql
-- 0008: credit-denominated two-bucket ledger, subscription plans as sole access,
-- Pro-only video, cycle resets, pack roll-over. Dev data wiped (Stripe TEST mode).

-- 0. Wipe dev money/library data --------------------------------------------
truncate public.generations cascade;      -- cascades to jobs
delete from public.ledger_entries;
delete from public.webhook_events;

-- 1. Ledger: integer credits + bucket ----------------------------------------
alter table public.ledger_entries
  drop column amount_usd,
  add column amount_credits integer not null default 0,
  add column bucket text not null default 'plan' check (bucket in ('plan','pack'));
alter table public.ledger_entries alter column amount_credits drop default;
alter table public.ledger_entries drop constraint ledger_entries_type_check;
alter table public.ledger_entries add constraint ledger_entries_type_check
  check (type in ('generate','edit','upscale','refund','pack_purchase','cycle_reset','pack_expiry','promo'));

-- 2. Generations: credit price + per-bucket charge attribution ----------------
alter table public.generations
  drop column price_usd,
  add column price_credits integer not null default 0,
  add column charged_plan integer not null default 0,
  add column charged_pack integer not null default 0;
alter table public.generations alter column price_credits drop default;

-- 3. Video (and any future premium family) is Pro-only ------------------------
alter table public.models
  add column min_plan text not null default 'studio' check (min_plan in ('studio','pro'));
update public.models set min_plan = 'pro'
  where id in ('veo','sora','kling','runway','seedance');

-- 4. Balances ------------------------------------------------------------------
drop function if exists public.fn_balance(uuid);
create or replace function public.fn_balances(p_user uuid)
returns table(plan_credits int, pack_credits int)
language sql security definer set search_path = public as $$
  select
    coalesce(sum(amount_credits) filter (where bucket = 'plan'), 0)::int,
    coalesce(sum(amount_credits) filter (where bucket = 'pack'), 0)::int
  from public.ledger_entries where user_id = p_user;
$$;

-- 5. Charge: plan bucket first, then pack; per-item attribution for refunds ----
drop function if exists public.fn_charge_and_generate(uuid, numeric, text, text, text, jsonb);
create or replace function public.fn_charge_and_generate(
  p_user uuid, p_amount int, p_type text, p_family_id text, p_note text, p_items jsonb
) returns setof public.generations
language plpgsql security definer set search_path = public as $$
declare
  v_plan int; v_pack int; v_owner boolean;
  v_from_plan int; v_from_pack int; v_rem_plan int;
  v_item jsonb; v_price int; v_cp int;
begin
  perform pg_advisory_xact_lock(hashtext(p_user::text));
  select exists (
    select 1 from public.subscriptions
    where user_id = p_user and plan = 'owner' and status = 'active'
  ) into v_owner;
  select bal.plan_credits, bal.pack_credits into v_plan, v_pack
    from public.fn_balances(p_user) bal;
  if not v_owner and v_plan + v_pack < p_amount then
    raise exception 'insufficient_balance' using errcode = 'P0001';
  end if;
  -- Owner usage is tracked as plan spend; balance may go negative by design.
  v_from_plan := case when v_owner then p_amount else least(greatest(v_plan, 0), p_amount) end;
  v_from_pack := p_amount - v_from_plan;
  if v_from_plan > 0 then
    insert into public.ledger_entries (user_id, type, bucket, amount_credits, family_id, note)
    values (p_user, p_type, 'plan', -v_from_plan, p_family_id, p_note);
  end if;
  if v_from_pack > 0 then
    insert into public.ledger_entries (user_id, type, bucket, amount_credits, family_id, note)
    values (p_user, p_type, 'pack', -v_from_pack, p_family_id, p_note);
  end if;
  v_rem_plan := v_from_plan;
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_price := (v_item->>'priceCredits')::int;
    v_cp := least(v_rem_plan, v_price);
    v_rem_plan := v_rem_plan - v_cp;
    return query
      insert into public.generations
        (user_id, kind, family_id, family_name, op, prompt, settings,
         price_credits, charged_plan, charged_pack, status, media_url, parent_id)
      values (
        p_user,
        v_item->>'kind', v_item->>'familyId', v_item->>'familyName', v_item->>'op',
        v_item->>'prompt', coalesce(v_item->'settings', '{}'::jsonb),
        v_price, v_cp, v_price - v_cp, 'pending', coalesce(v_item->>'mediaUrl', ''),
        nullif(v_item->>'parentId','')::uuid
      ) returning *;
  end loop;
end $$;

-- 6. Refund goes back to the buckets that paid (once per generation per bucket) --
create or replace function public.fn_fail_job(p_job uuid, p_error text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_gen uuid; v_user uuid; v_status text; v_cp int; v_cpack int;
begin
  select j.generation_id, j.user_id into v_gen, v_user from public.jobs j where j.id = p_job;
  if v_gen is null then return; end if;
  update public.jobs set error = p_error, updated_at = now() where id = p_job;
  select status, charged_plan, charged_pack into v_status, v_cp, v_cpack
    from public.generations where id = v_gen;
  if v_status is distinct from 'pending' then return; end if;
  update public.generations set status = 'failed' where id = v_gen;
  if v_cp > 0 then
    insert into public.ledger_entries (user_id, type, bucket, amount_credits, note)
    values (v_user, 'refund', 'plan', v_cp, 'refund:' || v_gen::text || ':plan')
    on conflict do nothing;
  end if;
  if v_cpack > 0 then
    insert into public.ledger_entries (user_id, type, bucket, amount_credits, note)
    values (v_user, 'refund', 'pack', v_cpack, 'refund:' || v_gen::text || ':pack')
    on conflict do nothing;
  end if;
end $$;

-- 7. Cycle reset: plan bucket snaps to the grant; packs untouched ---------------
create or replace function public.fn_cycle_reset(p_user uuid, p_grant int)
returns void language plpgsql security definer set search_path = public as $$
declare v_plan int;
begin
  perform pg_advisory_xact_lock(hashtext(p_user::text));
  select bal.plan_credits into v_plan from public.fn_balances(p_user) bal;
  insert into public.ledger_entries (user_id, type, bucket, amount_credits, note)
  values (p_user, 'cycle_reset', 'plan', p_grant - v_plan, 'Cycle renewal grant');
end $$;

-- 8. Pack grant (webhook only; stripe_ref UNIQUE = one session, one grant) ------
create or replace function public.fn_grant_pack(p_user uuid, p_credits int, p_stripe_ref text)
returns void language sql security definer set search_path = public as $$
  insert into public.ledger_entries (user_id, type, bucket, amount_credits, note, stripe_ref)
  values (p_user, 'pack_purchase', 'pack', p_credits, 'Credit pack', p_stripe_ref)
  on conflict (stripe_ref) do nothing;
$$;

-- 9. Pack credits die 30 days after the subscription lapses --------------------
select cron.schedule('expire_lapsed_packs', '30 3 * * *', $$
  insert into public.ledger_entries (user_id, type, bucket, amount_credits, note)
  select s.user_id, 'pack_expiry', 'pack', -bal.pack, 'Pack expiry (subscription lapsed)'
  from public.subscriptions s
  join lateral (
    select coalesce(sum(amount_credits), 0)::int as pack
    from public.ledger_entries l where l.user_id = s.user_id and l.bucket = 'pack'
  ) bal on true
  where s.status = 'expired'
    and s.current_period_end < now() - interval '30 days'
    and bal.pack > 0
$$);

-- 10. Backoffice readers still reference dropped columns — repoint to credits ----
-- backoffice_owner_usage: 'spendUsd' → spend_credits, 'balanceUsd' → credit buckets.
create or replace function public.backoffice_owner_usage()
returns jsonb language sql security definer set search_path = public as $$
select coalesce(jsonb_agg(jsonb_build_object(
  'userId', s.user_id,
  'email', (select email from auth.users where id = s.user_id),
  'displayName', p.display_name,
  'generations', (select count(*) from generations g where g.user_id = s.user_id),
  'spendCredits', coalesce((select sum(price_credits) from generations g where g.user_id = s.user_id), 0),
  'planCredits', coalesce((select sum(amount_credits) from ledger_entries l where l.user_id = s.user_id and l.bucket = 'plan'), 0),
  'packCredits', coalesce((select sum(amount_credits) from ledger_entries l where l.user_id = s.user_id and l.bucket = 'pack'), 0),
  'daily', (select coalesce(jsonb_agg(jsonb_build_object('day', d.day, 'value', coalesce(g.c, 0)) order by d.day), '[]'::jsonb)
            from (select generate_series(current_date - 29, current_date, interval '1 day')::date as day) d
            left join (select created_at::date as day, count(*) c from generations
                       where user_id = s.user_id and created_at > current_date - 29 group by 1) g using (day))
)), '[]'::jsonb)
from subscriptions s
join profiles p on p.id = s.user_id
where s.plan = 'owner';
$$;

-- backoffice_summary: gen_cost_usd_30d → gen_credits_30d (same jsonb key rename).
-- Reapply the 0007 body with the single line
--   'gen_cost_usd_30d', coalesce((select sum(price_usd) ...), 0),
-- replaced by
--   'gen_credits_30d', coalesce((select sum(price_credits) from generations where created_at > now() - interval '30 days'), 0),
-- (full function body otherwise identical to 0007 §7 — copy it verbatim).

-- 11. Lockdown -------------------------------------------------------------------
revoke execute on function public.fn_balances(uuid) from public, anon, authenticated;
revoke execute on function public.fn_charge_and_generate(uuid, int, text, text, text, jsonb) from public, anon, authenticated;
revoke execute on function public.fn_cycle_reset(uuid, int) from public, anon, authenticated;
revoke execute on function public.fn_grant_pack(uuid, int, text) from public, anon, authenticated;
grant execute on function public.fn_balances(uuid) to service_role;
grant execute on function public.fn_charge_and_generate(uuid, int, text, text, text, jsonb) to service_role;
grant execute on function public.fn_cycle_reset(uuid, int) to service_role;
grant execute on function public.fn_grant_pack(uuid, int, text) to service_role;
```

- [ ] **Step 2: Apply via MCP** `execute_sql` (whole file, one call). Expected: success.

- [ ] **Step 3: Smoke-test the RPCs via MCP `execute_sql`**

```sql
-- fabricate a user, grant, charge, fail, verify buckets
select public.fn_cycle_reset(id, 1500) from public.profiles limit 1;
select * from public.fn_balances((select id from public.profiles limit 1));
```

Expected: `plan_credits = 1500, pack_credits = 0`. Then clean up: `delete from public.ledger_entries where note = 'Cycle renewal grant';`

- [ ] **Step 4: Notify user** migration applied and file ready (do not commit).

---

### Task 3: API gateway — credits, subscription gate, Pro-only video

**Files:**
- Modify: `supabase/functions/api/index.ts`
- Modify: `supabase/functions/_shared/model-families.ts` (regenerated: run `npm run sync-shared` first so `creditCost`, `packCredits`, `PLAN_CREDITS`, `EDIT_TOOLS.creditCost` exist)

**Interfaces:**
- Consumes: Task 1 catalog exports, Task 2 RPCs.
- Produces API contract used by frontend tasks:
  - `GET /profile` → `{ profile, credits: { plan: number, pack: number }, subscription }` (replaces `balanceUsd`).
  - `POST /generations` → `{ items, credits: { plan, pack } }`; errors `subscription_required` (403), `pro_required` (403), `insufficient_credits` (402).
  - `GenerationDto.priceCredits: number` (replaces `priceUsd`).
  - `POST /billing/subscribe { plan: 'studio' | 'pro' }` → `{ url }`.
  - `POST /billing/pack { usd: number }` → `{ url }`; 403 `subscription_required` without active paid plan.
  - `GET /ledger` entries → `{ amountCredits, bucket, type, ... }`.

- [ ] **Step 1: Run `npm run sync-shared`** so `_shared/model-families.ts` matches Task 1. Expected: file regenerated, `creditCost` present.

- [ ] **Step 2: Rewrite pricing/balance plumbing in `api/index.ts`**

1. Replace imports `userPriceUsd, upscaleUserPriceUsd` with `creditCost, upscaleCreditCost, packCredits, PLAN_CREDITS, CREDIT_PACKS` from `../_shared/model-families.ts`.
2. Replace `balanceOf` helper with:

```ts
async function creditsOf(userId: string): Promise<{ plan: number; pack: number }> {
  const { data, error } = await admin.rpc('fn_balances', { p_user: userId });
  if (error) throw new Error(error.message);
  const row = Array.isArray(data) ? data[0] : data;
  return { plan: row?.plan_credits ?? 0, pack: row?.pack_credits ?? 0 };
}
```

3. Replace `hasActiveStudio` with a plan resolver (keep the old export name off; update call sites):

```ts
/** Highest active plan, or null. canceled = works until period end (status stays functional). */
async function activePlan(userId: string): Promise<'studio' | 'pro' | 'owner' | null> {
  const { data } = await admin
    .from('subscriptions')
    .select('plan, status, current_period_end')
    .eq('user_id', userId)
    .maybeSingle();
  if (!data) return null;
  if (data.status === 'expired') return null;
  if (
    data.status === 'canceled' &&
    data.current_period_end && new Date(data.current_period_end).getTime() < Date.now()
  ) return null;
  return data.plan as 'studio' | 'pro' | 'owner';
}
```

4. In `POST /generations`, after the suspension check, add the subscription gate:

```ts
const plan = await activePlan(userId);
if (!plan) {
  return fail(c, 403, 'subscription_required', 'An active subscription is required to generate.');
}
```

5. Replace the `unitPrice` computation block: `unitPrice`→`unitCredits` (int). Upscale: `unitCredits = upscaleCreditCost();`. Edit tools: keep `op=edit` + mask checks, drop the separate `hasActiveStudio` check (covered by the gate above), `unitCredits = editTool.creditCost;`. Families: `unitCredits = creditCost(family, settings);` and add the video gate right after the family lookup:

```ts
if (family.kind === MediaKind.Video && plan === 'studio') {
  return fail(c, 403, 'pro_required', 'Video models require the Pro plan.');
}
```

(Also apply `min_plan` from the `models` table when loading `modelEnabled` if that helper already selects the row — gate on `min_plan === 'pro' && plan === 'studio'` for future-proofing.)

6. Charge call: `p_amount: total` where `const total = unitCredits * batch;`, items get `priceCredits: unitCredits` (remove `priceUsd`), error mapping `insufficient_balance` → 402 `insufficient_credits` `'Not enough credits for this run'`.
7. Response: `return c.json({ items: ..., credits: await creditsOf(userId) });`
8. `toGenerationDtos`/DTO mapping: `priceUsd: Number(row.price_usd)` → `priceCredits: Number(row.price_credits)`.
9. `GET /profile` response: replace `balanceUsd` with `credits: await creditsOf(userId)`.
10. `GET /ledger` mapping: emit `amountCredits: Number(row.amount_credits)`, `bucket: row.bucket`.
11. `POST /edits/save` and `POST /library/import`: replace `hasActiveStudio` gate with `if (!(await activePlan(userId))) return fail(c, 403, 'subscription_required', ...)`; insert `price_credits: 0` instead of `price_usd: 0`.

- [ ] **Step 3: Replace the billing routes**

Delete `POST /billing/checkout` and the `TOPUP_PRESETS` constant. Add:

```ts
const PLAN_PRICE_IDS: Record<string, string | undefined> = {
  studio: Deno.env.get('STRIPE_STUDIO_PRICE_ID'),
  pro: Deno.env.get('STRIPE_PRO_PRICE_ID'),
};
const LAUNCH_COUPON_ID = Deno.env.get('STRIPE_LAUNCH_COUPON_ID'); // $5 off, 2 months

app.post('/billing/subscribe', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json().catch(() => ({}));
  const plan = body.plan === 'pro' ? 'pro' : body.plan === 'studio' ? 'studio' : null;
  if (!plan) return fail(c, 400, 'invalid_plan', 'plan must be studio or pro');
  const { data: ownSub } = await admin
    .from('subscriptions')
    .select('plan, status, stripe_subscription_id')
    .eq('user_id', userId)
    .maybeSingle();
  if (ownSub?.plan === 'owner' && ownSub.status === 'active') {
    return fail(c, 400, 'owner_plan', 'Owner accounts have unlimited credits');
  }
  if (ownSub?.stripe_subscription_id && ownSub.status === 'active') {
    return fail(c, 400, 'already_subscribed', 'Use the billing portal to change plans');
  }
  try {
    const customer = await stripeCustomerFor(userId, c.get('email'));
    // Launch promo: first-time subscribers only (never had a Stripe subscription).
    const firstTime = !ownSub?.stripe_subscription_id;
    const session = await stripe.checkout.sessions.create({
      customer,
      mode: 'subscription',
      line_items: [{ price: PLAN_PRICE_IDS[plan]!, quantity: 1 }],
      discounts: firstTime && LAUNCH_COUPON_ID ? [{ coupon: LAUNCH_COUPON_ID }] : undefined,
      success_url: `${APP_ORIGIN}/app?checkout=success`,
      cancel_url: `${APP_ORIGIN}/app?checkout=canceled`,
      metadata: { user_id: userId, plan },
      subscription_data: { metadata: { user_id: userId, plan } },
    });
    return c.json({ url: session.url });
  } catch (e) {
    logError(c, 'subscribe_failed', e);
    return fail(c, 400, 'billing_failed', 'Could not start checkout');
  }
});

app.post('/billing/pack', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json().catch(() => ({}));
  const usd = Number(body.usd);
  const plan = await activePlan(userId);
  if (!plan) return fail(c, 403, 'subscription_required', 'Packs are for active subscribers.');
  if (plan === 'owner') return fail(c, 400, 'owner_plan', 'Owner accounts have unlimited credits');
  if (!CREDIT_PACKS.some((p) => p.usd === usd)) {
    return fail(c, 400, 'invalid_amount', `usd must be one of ${CREDIT_PACKS.map((p) => p.usd).join(', ')}`);
  }
  const credits = packCredits(usd, plan);
  try {
    const customer = await stripeCustomerFor(userId, c.get('email'));
    const session = await stripe.checkout.sessions.create({
      customer,
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: `Vansen credit pack — ${credits.toLocaleString()} credits` },
          unit_amount: usd * 100,
        },
        quantity: 1,
      }],
      success_url: `${APP_ORIGIN}/app?checkout=success`,
      cancel_url: `${APP_ORIGIN}/app?checkout=canceled`,
      metadata: { user_id: userId, pack_usd: String(usd), pack_credits: String(credits) },
    });
    return c.json({ url: session.url });
  } catch (e) {
    logError(c, 'pack_failed', e);
    return fail(c, 400, 'billing_failed', 'Could not start checkout');
  }
});
```

Rewrite `POST /billing/reconcile` to look for `pack_credits` metadata instead of `credits_usd`, calling `fn_grant_pack`:

```ts
for (const s of sessions.data) {
  if (s.payment_status !== 'paid') continue;
  const credits = Number(s.metadata?.pack_credits ?? 0);
  if (!credits) continue;
  const { error } = await admin.rpc('fn_grant_pack', {
    p_user: userId, p_credits: credits, p_stripe_ref: s.id,
  });
  if (!error) credited += 1;
}
return c.json({ credited, credits: await creditsOf(userId) });
```

- [ ] **Step 4: Type-check** `deno check supabase/functions/api/index.ts` (or `npx ng build` won't cover Deno — use the Supabase CLI if present; otherwise rely on editor/LSP diagnostics). Expected: no errors.

- [ ] **Step 5: Notify user** ready (deploy happens in Task 12).

---

### Task 4: stripe-webhook — plan grants, cycle resets, pack grants

**Files:**
- Modify: `supabase/functions/stripe-webhook/index.ts`

**Interfaces:**
- Consumes: `fn_cycle_reset`, `fn_grant_pack` (Task 2), `PLAN_CREDITS` from `../_shared/model-families.ts`.
- Env additions: `STRIPE_PRO_PRICE_ID` (STRIPE_STUDIO_PRICE_ID already exists; both now needed here too).

- [ ] **Step 1: Rewrite the event handlers**

1. Add imports/constants:

```ts
import { PLAN_CREDITS } from '../_shared/model-families.ts';

const STUDIO_PRICE_ID = Deno.env.get('STRIPE_STUDIO_PRICE_ID');
const PRO_PRICE_ID = Deno.env.get('STRIPE_PRO_PRICE_ID');

function planFor(sub: Stripe.Subscription): 'studio' | 'pro' {
  const priceId = sub.items.data[0]?.price?.id;
  if (priceId === PRO_PRICE_ID) return 'pro';
  if (priceId === STUDIO_PRICE_ID) return 'studio';
  // metadata fallback (set at checkout); default studio, loud log
  const meta = sub.metadata?.plan;
  if (meta === 'pro' || meta === 'studio') return meta;
  console.error('unknown price id on subscription', sub.id, priceId);
  return 'studio';
}
```

2. `checkout.session.completed` / `async_payment_succeeded`: delete the `credits_usd` block. New body:

```ts
const session = event.data.object as Stripe.Checkout.Session;
if (session.payment_status !== 'paid') break;
const userId = session.metadata?.user_id;
if (!userId) break;

if (session.mode === 'payment') {
  const credits = Number(session.metadata?.pack_credits ?? 0);
  const usd = Number(session.metadata?.pack_usd ?? 0);
  // Integrity: metadata must match Stripe's own subtotal.
  if (credits > 0 && session.amount_subtotal === usd * 100) {
    const { error } = await admin.rpc('fn_grant_pack', {
      p_user: userId, p_credits: credits, p_stripe_ref: session.id,
    });
    if (error) throw error;
  } else if (credits > 0) {
    console.error('pack amount mismatch', session.id, session.amount_subtotal, usd * 100);
  }
}

if (session.mode === 'subscription' && session.subscription) {
  const sub = await stripe.subscriptions.retrieve(String(session.subscription));
  await upsertSubscription(userId, sub);
  // Grant happens on invoice.paid (fires for the first invoice too).
}
break;
```

3. `invoice.paid`: after `upsertSubscription`, add the cycle grant:

```ts
if (userId) {
  await upsertSubscription(userId, sub);
  const plan = planFor(sub);
  const alive = sub.status === 'active' || sub.status === 'trialing' || sub.status === 'past_due';
  if (alive) {
    const { error } = await admin.rpc('fn_cycle_reset', {
      p_user: userId, p_grant: PLAN_CREDITS[plan],
    });
    if (error) throw error;
  }
}
```

4. `upsertSubscription`: replace the hardcoded `plan: 'studio'` with `plan: planFor(sub)`.

- [ ] **Step 2: Verify** with `deno check` (as in Task 3). Expected: clean.

- [ ] **Step 3: Notify user** ready (deploy in Task 12).

---

### Task 5: Frontend core — DTOs, enums, ledger/profile/billing services

**Files:**
- Modify: `src/app/core/enums.ts` (LedgerType values)
- Modify: `src/app/core/api/dtos.ts`
- Modify: `src/app/core/ledger/ledger-service.ts` + `ledger-service.spec.ts`
- Modify: `src/app/core/profile/profile-store.ts` + `profile-store.spec.ts`
- Modify: `src/app/core/billing/billing-service.ts` + `billing-service.spec.ts`
- Modify: `src/app/core/generations/generation-store.ts` + `generation-store.spec.ts`

**Interfaces (produced, used by all UI tasks):**
- `LedgerService.planCredits(): number`, `packCredits(): number`, `totalCredits(): number`, `setCredits(c: {plan: number; pack: number}): void`.
- `ProfileStore.plan(): 'studio' | 'pro' | 'owner' | null` (active plan or null), existing `ownerActive`, `proActive` retained.
- `BillingService.subscribe(plan: 'studio' | 'pro')`, `buyPack(usd: number)`, `openPortal()`, `reconcile()`.
- DTOs: `CreditsDto { plan: number; pack: number }`; `ProfileResponse.credits: CreditsDto`; `CreateGenerationResponse.credits: CreditsDto`; `GenerationDto.priceCredits: number`; `LedgerEntryDto.amountCredits: number; bucket: 'plan' | 'pack'`.

- [ ] **Step 1: Write failing tests** (adapt existing specs; new assertions):

```ts
// ledger-service.spec.ts
it('exposes bucket balances and total', () => {
  service.setCredits({ plan: 1200, pack: 300 });
  expect(service.planCredits()).toBe(1200);
  expect(service.packCredits()).toBe(300);
  expect(service.totalCredits()).toBe(1500);
});

// billing-service.spec.ts
it('subscribes via /billing/subscribe', async () => {
  api.post.mockResolvedValue({ url: 'https://stripe/x' });
  await service.subscribe('pro');
  expect(api.post).toHaveBeenCalledWith('/billing/subscribe', { plan: 'pro' });
  expect(navigated).toEqual(['https://stripe/x']);
});
it('buys packs via /billing/pack', async () => {
  api.post.mockResolvedValue({ url: 'https://stripe/y' });
  await service.buyPack(50);
  expect(api.post).toHaveBeenCalledWith('/billing/pack', { usd: 50 });
});
```

(Mirror existing spec style — the current specs already mock `ApiService` and `BILLING_NAVIGATE`.)

- [ ] **Step 2: Run** `npm test -- ledger-service billing-service`. Expected: FAIL (methods missing).

- [ ] **Step 3: Implement**

- `enums.ts`: `LedgerType` values become `generate | edit | upscale | refund | pack_purchase | cycle_reset | pack_expiry | promo` (delete `topup`, `studio_fee`, `trial_credit`).
- `dtos.ts`: add `CreditsDto`, swap fields as listed in Interfaces; `CheckoutRequest` becomes `{ plan?: 'studio' | 'pro'; usd?: number }`; `ReconcileResponse.balanceUsd` → `credits: CreditsDto`.
- `ledger-service.ts`: replace `balanceSig`/`balanceUsd`/`setBalance` with

```ts
private readonly creditsSig = signal<{ plan: number; pack: number }>({ plan: 0, pack: 0 });
readonly planCredits = computed(() => this.creditsSig().plan);
readonly packCredits = computed(() => this.creditsSig().pack);
readonly totalCredits = computed(() => this.creditsSig().plan + this.creditsSig().pack);
setCredits(credits: { plan: number; pack: number }): void {
  this.creditsSig.set(credits);
}
```

- `profile-store.ts`: `load()` pushes `response.credits` via `setCredits`; add

```ts
/** Active plan id, or null (expired / never subscribed). */
readonly plan = computed<'studio' | 'pro' | 'owner' | null>(() => {
  const sub = this.profileSig()?.subscription ?? null; // adjust to actual shape
  if (!sub) return null;
  if (sub.status === SubscriptionStatus.Expired) return null;
  return sub.plan;
});
```

(Keep `studioActive`/`proActive`/`ownerActive` semantics working on top of it.)
- `billing-service.ts`: `checkout(creditsUsd)`/`reactivateStudio()` → `subscribe(plan)` and `buyPack(usd)` posting the new routes; `reconcile()` sets `setCredits(response.credits)`.
- `generation-store.ts`: `create()` uses `this.ledger.setCredits(response.credits)`; `applyJobUpdates` refund notification becomes

```ts
title: `Refunded ${update.priceCredits} credits`,
```

- [ ] **Step 4: Run the full suite** `npm test`. Fix remaining compile errors in specs (`balanceUsd` references) but leave feature-component templates for Tasks 6–10 — if the suite can't compile because of them, do the minimal mechanical rename in those files now (`balanceUsd()` → `totalCredits()`, `priceUsd` → `priceCredits`) and leave copy/UX changes to their tasks. Expected: PASS.

- [ ] **Step 5: Notify user** ready.

---

### Task 6: Workspace UI — credit chips, balances, PRO locks

**Files:**
- Modify: `src/app/features/workspace/left-panel/left-panel.ts` + `.html` (+ `.css` for the lock badge)
- Modify: `src/app/shared/profile-menu/profile-menu.ts` + `.html`
- Modify: `src/app/features/workspace/detail-overlay/detail-overlay.ts` + `.html`
- Modify: `src/app/features/workspace/library-grid/library-grid.html`
- Modify: `src/app/features/studio/right-panel/right-panel.ts` + `.html`, `src/app/features/studio/tool-options/tool-options.ts`

**Interfaces:**
- Consumes: `creditCost`, `upscaleCreditCost`, `EDIT_TOOLS[].creditCost` (Task 1); `LedgerService.totalCredits` (Task 5); `ProfileStore.plan` (Task 5).

- [ ] **Step 1: left-panel**

- `unitPriceUsd`/`priceUsd` computed → `unitCredits = computed(() => creditCost(this.family(), this.settings()))`, `priceCredits = computed(() => this.unitCredits() * this.batch())`, `insufficient = computed(() => this.priceCredits() > this.ledger.totalCredits())`.
- Template price line (`left-panel.html:203`): `· <span class="num">${{ priceUsd() | number: '1.2-2' }}</span>` → `· <span class="num">{{ priceCredits() }} cr</span>`.
- Video families for Studio users: add `readonly videoLocked = computed(() => this.family().kind === 'video' && this.profile.plan() === 'studio');` — disable Generate with a `PRO` badge chip on video model cards (class `model-pro-lock`, uppercase micro-title styling per the panel design language). Clicking a locked card routes to `/pricing` (or plans page).
- Batch/`priceUsd` request field: `CreateGenerationRequest` carries no price (server prices) — check `left-panel.ts:271` sends `priceUsd`; delete that field from the request and DTO if present.

- [ ] **Step 2: profile-menu** — `balanceUsd` → `totalCredits`; template shows `{{ totalCredits() | number }} cr` (owner keeps "Unlimited"); low-balance class threshold `< 100` credits.

- [ ] **Step 3: detail-overlay / library-grid / right-panel / tool-options** — mechanical: every `$X.XX` price render becomes `N cr`; `tool-options.ts` `aiRemovePrice`/`aiFillPrice` read `creditCost` (integers, no `.toFixed`); upscale button shows `{{ upscaleCredits }} cr` from `upscaleCreditCost()`. Local tools show no price (unchanged).

- [ ] **Step 4: Run** `npm test` and `npx ng build`. Expected: PASS/clean.

- [ ] **Step 5: Notify user** ready.

---

### Task 7: Plans page + billing tab — subscribe, packs, buckets

**Files:**
- Modify: `src/app/features/plans/plans-page.ts` + `.html` + `.css`
- Modify: `src/app/features/settings/billing-tab/billing-tab.ts` + `.html` (+ `.css`)
- Modify: `src/app/features/workspace/workspace-page.ts` (checkout=success handling stays: reconcile + profile reload)

**Interfaces:**
- Consumes: `BillingService.subscribe/buyPack/openPortal` (Task 5), `CREDIT_PACKS`, `packCredits`, `PLAN_CREDITS` (Task 1), `ProfileStore.plan`, `LedgerService` buckets.

- [ ] **Step 1: plans-page** — two cards:

- Studio: `$15/mo` (promo strip: `$10/mo for your first 60 days`), `1,500 credits every month`, bullets: all image models, full editing suite, AI tools from 5 cr. CTA → `billing.subscribe('studio')`.
- Pro: `$30/mo` (promo `$25/mo`), `3,750 credits every month — 25% more per dollar`, bullets: everything in Studio + video models, cheapest credits. CTA → `billing.subscribe('pro')`.
- Footnote: "Included credits reset each billing cycle. Add-on pack credits roll over while your subscription is active."
- Promo strip shows only for users with no prior Stripe subscription (`profile.plan() === null` is the client approximation; the server enforces the coupon).
- Follow the panel design language: sectioned cards, uppercase micro-titles, muted labels.

- [ ] **Step 2: billing-tab**

- Header card: plan name + renewal date + per-bucket balances (`Plan credits — reset {date}` / `Pack credits — roll over`).
- Pack purchase row: four buttons, each labelled `${{p.usd}} → {{ packCredits(p.usd, plan) | number }} cr` (uses the caller's active plan; hidden for owner and non-subscribers).
- Replace any `TOPUP` preset UI. Keep `openPortal()` for cancel/card. Cancel note: "Pack credits expire 30 days after your subscription ends."
- Ledger list: render `amountCredits` (+ bucket tag chip `plan`/`pack`) instead of dollars; map new `LedgerType` labels: `pack_purchase` → "Credit pack", `cycle_reset` → "Monthly grant", `pack_expiry` → "Pack expiry", `refund` → "Refund".

- [ ] **Step 3: Run** `npm test` + `npx ng build`. Expected: clean.

- [ ] **Step 4: Notify user** ready.

---

### Task 8: Pricing page + pricing engine (public marketing calculator)

**Files:**
- Rewrite: `src/app/features/pricing/pricing-engine.ts` (+ its spec if present, else create `pricing-engine.spec.ts`)
- Modify: `src/app/features/pricing/pricing-page.ts` + `.html` + `.css`
- Leave: `src/app/features/pricing/model-catalog.ts` (deprecated, admin-only) — but move `PAYG_MARGIN` INTO it if anything still imports it; nothing in `model-families.ts` may import from it anymore (done in Task 1).

**Interfaces:**
- Produces: `creditValueUsd(plan: 'studio' | 'pro'): number` (0.01 / 0.008), `jobsPerMonth(creditsPerJob: number, plan): number`, `effectiveUsd(creditsPerJob: number, plan): number`.

- [ ] **Step 1: Failing tests**

```ts
import { creditValueUsd, effectiveUsd, jobsPerMonth } from './pricing-engine';

describe('credit pricing engine', () => {
  it('values credits by plan', () => {
    expect(creditValueUsd('studio')).toBeCloseTo(0.01);
    expect(creditValueUsd('pro')).toBeCloseTo(0.008);
  });
  it('translates a 10-credit job', () => {
    expect(effectiveUsd(10, 'studio')).toBeCloseTo(0.1);
    expect(effectiveUsd(10, 'pro')).toBeCloseTo(0.08);
    expect(jobsPerMonth(10, 'studio')).toBe(150);   // 1500 / 10
    expect(jobsPerMonth(10, 'pro')).toBe(375);      // 3750 / 10
  });
});
```

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement**

```ts
import { PLAN_CREDITS, PRO_PURCHASE_RATE } from '../../core/catalog/model-families';

const PLAN_PRICE_USD = { studio: 15, pro: 30 } as const;

export function creditValueUsd(plan: 'studio' | 'pro'): number {
  return PLAN_PRICE_USD[plan] / PLAN_CREDITS[plan];
}

export function effectiveUsd(creditsPerJob: number, plan: 'studio' | 'pro'): number {
  return creditsPerJob * creditValueUsd(plan);
}

export function jobsPerMonth(creditsPerJob: number, plan: 'studio' | 'pro'): number {
  return Math.floor(PLAN_CREDITS[plan] / creditsPerJob);
}
```

Delete the old `PricingConfig`/`MarginResult`/`requiredCredits`/`marginFor` exports (grep for external usages first; migrate any admin usage to the deprecated `model-catalog.ts` or delete).

- [ ] **Step 4: pricing-page** — rebuild sections: plan cards (mirror Task 7 copy), pack table (both tiers side by side), interactive calculator: model picker (from `MODEL_FAMILIES`) + settings → `creditCost` → "N cr ≈ $X on Studio / $Y on Pro · Z runs per month included". Video rows badge `PRO`. Promo strip.

- [ ] **Step 5: Run** `npm test` + build. **Step 6: Notify user.**

---

### Task 9: Homepage (landing) copy

**Files:**
- Modify: `src/app/features/landing/landing-page.html` (+ `.ts` if pricing values are bound)

- [ ] **Step 1:** Grep `landing-page.*` for `$`, `credit`, `Studio`, `15`, `5` — replace the old "first purchase $15 = $10 credits + $5/mo Studio" story with: Studio `$15/mo · 1,500 credits` / Pro `$30/mo · 3,750 credits + video`, promo banner `Launch offer: $10 / $25 for your first 60 days`, CTA → `/pricing`. Keep hero structure; copy only.
- [ ] **Step 2:** `npx ng build`. **Step 3: Notify user.**

---

### Task 10: Onboarding tour — credits copy + subscribe beat

**Files:**
- Modify: `src/app/core/tour/tour-service.ts` + `tour-service.spec.ts`
- Modify: `src/app/shared/tour-overlay/` (CTA button on the final step, if the overlay doesn't already render per-step actions)

**Interfaces:**
- Consumes: `ProfileStore.plan` (Task 5).
- Produces: `TourStep.id` union gains `'subscribe'`; `TourService.steps()` (or equivalent visible-steps accessor) filters it out for subscribed users.

- [ ] **Step 1: Failing tests**

```ts
it('rewrites the credits step for the subscription model', () => {
  const credits = TOUR_STEPS.find((s) => s.id === 'credits')!;
  expect(credits.body).toContain('reset');       // monthly reset
  expect(credits.body).toContain('roll over');   // packs
});

it('shows the subscribe step only to non-subscribers', () => {
  // with profile.plan() === null
  expect(service.visibleSteps().some((s) => s.id === 'subscribe')).toBe(true);
  // with plan 'studio'
  expect(service.visibleSteps().some((s) => s.id === 'subscribe')).toBe(false);
});
```

(Match the spec file's existing TestBed setup/mocks.)

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement**

- `credits` step body → `'Your monthly credits reset each billing cycle; add-on pack credits roll over while subscribed. Failed generations are refunded automatically.'`
- Append step:

```ts
{
  id: 'subscribe',
  target: null,
  placement: 'center',
  title: 'Pick your plan',
  body: 'Studio $15/mo (1,500 credits) or Pro $30/mo (3,750 credits + video). Launch offer: $10/$25 for your first 60 days.',
},
```

- `TourService`: expose `visibleSteps = computed(() => this.profile.plan() ? TOUR_STEPS.filter(s => s.id !== 'subscribe') : TOUR_STEPS)` and drive the overlay from it. Overlay renders a "See plans" button on the `subscribe` step routing to `/app/plans` (or `/pricing`).

- [ ] **Step 4: Run** `npm test`. **Step 5: Notify user.**

---

### Task 11: Retire dead billing surfaces + full sweep

**Files:**
- Modify: `src/app/features/settings/settings-page.html`/`.ts` (any top-up affordances)
- Search-and-destroy: `grep -rn "balanceUsd\|priceUsd\|amountUsd\|topup\|studio_fee\|trial_credit\|TOPUP\|reactivateStudio\|studioOnly\|creditsUsd" src/ supabase/functions/`

- [ ] **Step 1:** Every hit is either renamed (Tasks 5–10 output) or deleted. `CheckoutRequest.studioOnly` gone; profile-menu "top up" links point at packs/plans.
- [ ] **Step 2:** `npm test` + `npx ng build`. Expected: zero hits for old symbols, suite green, build clean.
- [ ] **Step 3: Notify user.**

---

### Task 12: Stripe fixtures, secrets, deploy, end-to-end verify

**Files:** none in repo (ops).

- [ ] **Step 1: User action (cannot be done by the agent — requires Stripe dashboard):** create in Stripe TEST mode and report back IDs:
  1. Product "Vansen Studio" — recurring price $15/mo → `STRIPE_STUDIO_PRICE_ID` (replaces the old $5 price).
  2. Product "Vansen Pro" — recurring price $30/mo → `STRIPE_PRO_PRICE_ID`.
  3. Coupon "LAUNCH60": `amount_off=500`, `currency=usd`, `duration=repeating`, `duration_in_months=2` → `STRIPE_LAUNCH_COUPON_ID`.
- [ ] **Step 2:** Set the three secrets on Supabase Edge Functions (user or MCP; never in repo).
- [ ] **Step 3:** Deploy `api` and `stripe-webhook` via MCP `deploy_edge_function`, bundling every `_shared/` file including `providers/`.
- [ ] **Step 4: End-to-end (Stripe test cards + test clock):**
  1. Fresh user → generate → expect 403 `subscription_required`.
  2. Subscribe Studio with promo → invoice.paid → balance 1,500 plan credits; Stripe shows $10.
  3. Generate image (e.g. Seedream = 5 cr) → balance 1,495; generation renders.
  4. Request video family → 403 `pro_required`.
  5. Buy $25 pack → +2,625 pack credits.
  6. Advance test clock one cycle → plan snaps to 1,500, pack untouched.
  7. Force a provider failure (disable model mid-flight or invalid settings) → refund lands in correct buckets.
- [ ] **Step 5:** `get_logs` + `get_advisors` on the project — no errors. **Notify user** with the verification transcript.

---

### Task 13: vankode-backoffice pass (separate repo — follow-up)

Not part of this repo's plan. After Tasks 1–12 land, open `vankode-backoffice` and update its consumers of the renamed RPC fields (migration 0008 §10 already repointed the SQL side): `spendUsd` → `spendCredits`, `balanceUsd` → `planCredits`/`packCredits`, `gen_cost_usd_30d` → `gen_credits_30d`. Add: plan column in user views, margin dashboard (credits × tier value − provider cost), promo cohort list (subscriptions created inside their first 2 discounted cycles).

---

## Self-review notes

- Spec coverage: plans/promo (T3/T4/T12), credit unit + charge table (T1/T3), two buckets + reset + pack expiry (T2/T4), packs (T1/T3/T7), Pro-only video (T2/T3/T6), AI-tool credit prices (T1/T3/T6), non-subscriber lockout (T3), all 7 surfaces (T6–T10, T13), tests (each task + T12 e2e).
- Known consistency traps: `backoffice_owner_usage()`/`backoffice_summary()` reference `price_usd`/`amount_usd` — Task 13 note covers the required 0008 addendum (`gen_cost_usd_30d` too).
- `fn_charge_and_generate` old signature dropped explicitly (`drop function`) because the parameter type changes from `numeric` to `int`.
