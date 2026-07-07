# Vansen MVP Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace all localStorage stubs with a real Supabase backend: project, schema+RPCs, an `api` Edge Function gateway, Google SSO + email/password auth, and an API-backed Angular data layer.

**Architecture:** Angular keeps supabase-js for AUTH ONLY; all data flows through one Hono-routed Edge Function that verifies JWTs, recomputes prices server-side from a shared catalog, and calls SECURITY DEFINER Postgres RPCs. Tables are RLS deny-all (service-role only). REST contract + SQL logic are the future Java-migration boundary.

**Tech Stack:** Supabase (Postgres 17, Auth, Edge Functions/Deno + Hono), supabase-js v2, Angular 22 signals, vitest.

## Global Constraints

- **NEVER `git commit`/`branch`/`push`** — user commits personally. Steps end at green tests/build, never commit.
- Components: separate `.ts/.html/.css`. No inline templates/styles.
- User price = `providerCost / (1 − 0.33)` — computed ON THE SERVER from shared catalog; client never sends prices.
- No string literals for domain values — everything through `src/app/core/enums.ts` (spec §7).
- Supabase org `oxblpifbnmlgiypkygdk`, project name `vansen`, region `ap-southeast-1`, cost $0 (approved).
- Angular masters for shared code; `scripts/sync-shared.mjs` copies to `supabase/functions/_shared/` adding `.ts` import extensions; vitest guards drift.
- Build: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use 22.23.1 >/dev/null && npx ng build`; tests: same + `npx ng test --watch=false`.
- Supabase operations via MCP tools (`create_project`, `apply_migration`, `deploy_edge_function`, `execute_sql`, `get_project_url`, `get_publishable_keys`, `get_logs`).
- Error body everywhere: `{ "error": { "code": string, "message": string } }`; 401/400/402/404 per spec §6.

---

### Task 1: Supabase project + env plumbing

**Files:**
- Create: `src/environments/environment.ts`, `src/environments/environment.development.ts`
- Modify: `angular.json` (fileReplacements if not present; Angular 22 default build may already support environments via `ng g environments` — run generator)

**Interfaces:**
- Produces: `environment = { apiBaseUrl: string; supabaseUrl: string; supabaseAnonKey: string }` consumed by Tasks 5–6. Project ref for Tasks 2/4.

- [ ] **Step 1:** MCP `create_project` (name `vansen`, org `oxblpifbnmlgiypkygdk`, region `ap-southeast-1`, confirm_cost_id from prior $0 confirmation via `confirm_cost` tool). Poll `get_project` until `ACTIVE_HEALTHY`.
- [ ] **Step 2:** MCP `get_project_url` + `get_publishable_keys` → capture URL + anon key.
- [ ] **Step 3:** `npx ng g environments` (creates `src/environments/` + fileReplacements). Fill both files:

```typescript
export const environment = {
  supabaseUrl: '<PROJECT_URL>',
  supabaseAnonKey: '<ANON_KEY>',
  apiBaseUrl: '<PROJECT_URL>/functions/v1/api',
};
```

- [ ] **Step 4:** Build green.

---

### Task 2: Schema migration + RPCs

**Files:** none in repo (DB migration via MCP `apply_migration`, name `foundation_schema`). Keep a copy at `supabase/migrations/0001_foundation_schema.sql` for the repo record.

**Interfaces:**
- Produces: tables `profiles/ledger_entries/generations/subscriptions`; RPCs `fn_balance(p_user uuid)`, `fn_charge_and_generate(p_user uuid, p_amount numeric, p_type text, p_family_id text, p_note text, p_items jsonb)`, `fn_delete_account(p_user uuid)`; trigger `handle_new_user`.

- [ ] **Step 1:** Apply migration (full SQL, also saved to the repo file):

```sql
create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  display_name text,
  strikes int not null default 0,
  prefs jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table public.ledger_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles on delete cascade,
  type text not null check (type in ('topup','generate','edit','upscale','studio_fee','trial_credit','promo','refund')),
  amount_usd numeric(10,2) not null,
  family_id text,
  note text,
  created_at timestamptz not null default now()
);
create index ledger_entries_user_idx on public.ledger_entries (user_id, created_at desc);

create table public.generations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles on delete cascade,
  kind text not null check (kind in ('image','video')),
  family_id text not null,
  family_name text not null,
  op text not null check (op in ('generate','edit','upscale','variation')),
  prompt text not null,
  settings jsonb not null default '{}',
  price_usd numeric(10,2) not null,
  status text not null check (status in ('pending','done','failed')),
  media_url text not null,
  parent_id uuid references public.generations on delete set null,
  created_at timestamptz not null default now()
);
create index generations_user_idx on public.generations (user_id, created_at desc);

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.profiles on delete cascade,
  plan text not null check (plan in ('studio','studio_pro')),
  status text not null check (status in ('active','canceled','expired')),
  current_period_end timestamptz,
  stripe_subscription_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- RLS: deny-all for client roles; only service_role (bypasses RLS) reaches data
alter table public.profiles enable row level security;
alter table public.ledger_entries enable row level security;
alter table public.generations enable row level security;
alter table public.subscriptions enable row level security;

-- signup trigger
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id) values (new.id);
  return new;
end $$;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.fn_balance(p_user uuid)
returns numeric language sql security definer set search_path = public as $$
  select coalesce(sum(amount_usd), 0) from public.ledger_entries where user_id = p_user;
$$;

create or replace function public.fn_charge_and_generate(
  p_user uuid, p_amount numeric, p_type text, p_family_id text, p_note text, p_items jsonb
) returns setof public.generations
language plpgsql security definer set search_path = public as $$
declare
  v_balance numeric;
  v_item jsonb;
begin
  perform pg_advisory_xact_lock(hashtext(p_user::text));
  select coalesce(sum(amount_usd), 0) into v_balance from public.ledger_entries where user_id = p_user;
  if v_balance < p_amount then
    raise exception 'insufficient_balance' using errcode = 'P0001';
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
        (v_item->>'priceUsd')::numeric, 'done', v_item->>'mediaUrl',
        nullif(v_item->>'parentId','')::uuid
      ) returning *;
  end loop;
end $$;

create or replace function public.fn_delete_account(p_user uuid)
returns void language sql security definer set search_path = public as $$
  delete from public.profiles where id = p_user;
$$;
```

- [ ] **Step 2:** Verify: MCP `list_tables` shows 4 tables with `rls_enabled: true`; `execute_sql` `select public.fn_balance('00000000-0000-0000-0000-000000000000')` → 0.
- [ ] **Step 3:** MCP `get_advisors` (security) — expect no criticals (RLS enabled everywhere; SECURITY DEFINER functions have fixed search_path).

---

### Task 3: Enums file + shared sync

**Files:**
- Create: `src/app/core/enums.ts`, `scripts/sync-shared.mjs`, `supabase/functions/_shared/` (generated)
- Test: `src/app/core/enums.spec.ts`, `scripts` integrity covered by same spec
- Modify: `src/app/core/generations/generation-store.ts`, `src/app/core/ledger/ledger-service.ts` (types re-exported from enums; no literal unions), `package.json` (script `"sync-shared": "node scripts/sync-shared.mjs"`)

**Interfaces:**
- Produces: `LedgerType`, `GenerationOp`, `GenerationStatus`, `MediaKind`, `SubscriptionPlan`, `SubscriptionStatus` (const objects + union types) — every later task imports these; `_shared/enums.ts`, `_shared/catalog.ts` for Task 4.

- [ ] **Step 1: Failing test** — enums exist and match DB CHECK lists:

```typescript
import { describe, expect, it } from 'vitest';
import { GenerationOp, GenerationStatus, LedgerType, MediaKind, SubscriptionPlan, SubscriptionStatus } from './enums';

describe('domain enums', () => {
  it('mirror DB check constraints exactly', () => {
    expect(Object.values(LedgerType).sort()).toEqual(
      ['edit','generate','promo','refund','studio_fee','topup','trial_credit','upscale'].sort());
    expect(Object.values(GenerationOp).sort()).toEqual(['edit','generate','upscale','variation'].sort());
    expect(Object.values(GenerationStatus).sort()).toEqual(['done','failed','pending'].sort());
    expect(Object.values(MediaKind).sort()).toEqual(['image','video'].sort());
    expect(Object.values(SubscriptionPlan).sort()).toEqual(['studio','studio_pro'].sort());
    expect(Object.values(SubscriptionStatus).sort()).toEqual(['active','canceled','expired'].sort());
  });
});
```

- [ ] **Step 2:** Implement `enums.ts` (const-object pattern per spec §7). Refactor `GenerationStore`/`LedgerService` to import these types (public shapes unchanged).
- [ ] **Step 3:** `scripts/sync-shared.mjs` — copies `src/app/core/enums.ts` and `src/app/core/catalog/model-families.ts` (+ its import `PAYG_MARGIN`: inline it during copy or copy `model-catalog.ts` too — simplest: the script rewrites the import line to a local `const PAYG_MARGIN = 0.33;` injection) into `supabase/functions/_shared/`, appending `.ts` to relative imports. Integrity test: script exports a `transform(src)` used by both the writer and the vitest that compares current `_shared` content to `transform(master)`.
- [ ] **Step 4:** Run script; tests + build green.

---

### Task 4: `api` Edge Function

**Files:**
- Create: `supabase/functions/api/index.ts` (+ uses `_shared/`)
- Deploy: MCP `deploy_edge_function` (name `api`, entrypoint `index.ts`, include `_shared` files in the files array)

**Interfaces:**
- Consumes: Task 2 RPCs, Task 3 `_shared` modules.
- Produces: routes per spec §6; DTO JSON shapes: `GenerationDto { id, kind, familyId, familyName, op, prompt, settings, priceUsd, status, mediaUrl, parentId, createdAt }`, `LedgerEntryDto { id, type, amountUsd, familyId, note, createdAt }`, `ProfileDto { id, email, displayName, prefs, createdAt }`, `GET /profile → { profile, balanceUsd, subscription }`, `POST /generations → { items, balanceUsd }`.

- [ ] **Step 1: Implement** (core shape — full file in repo):

```typescript
import { Hono } from 'jsr:@hono/hono';
import { cors } from 'jsr:@hono/hono/cors';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { familyById, userPriceUsd, upscaleUserPriceUsd } from '../_shared/model-families.ts';
import { GenerationOp, LedgerType } from '../_shared/enums.ts';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const app = new Hono().basePath('/api');
app.use('*', cors({ origin: ['http://localhost:4200'], allowHeaders: ['authorization','content-type'] }));

const err = (c: any, status: number, code: string, message: string) =>
  c.json({ error: { code, message } }, status);

app.use('*', async (c, next) => {
  const token = c.req.header('authorization')?.replace(/^Bearer /i, '');
  if (!token) return err(c, 401, 'unauthorized', 'Missing token');
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return err(c, 401, 'unauthorized', 'Invalid token');
  c.set('userId', data.user.id);
  c.set('email', data.user.email ?? '');
  await next();
});

// GET /profile → profile + balance + subscription
// PATCH /profile { displayName } ; DELETE /profile (fn_delete_account + admin.auth.admin.deleteUser)
// PUT /prefs ; GET /ledger (limit 100) ; GET /generations ; DELETE /generations/:id (ownership check)
// POST /generations:
//   body { familyId, op, prompt, settings, batch=1, parentId? }
//   validate: family exists (or op==='upscale' → UPSCALER), op in GenerationOp, 1<=batch<=4,
//             prompt non-empty, video families reject op edit/upscale
//   unit = op==='upscale' ? upscaleUserPriceUsd() : userPriceUsd(family, settings)
//   total = round2(unit * batch); ledgerType = op==='variation' ? 'generate' : op
//   items = batch × { kind, familyId, familyName, op, prompt, settings, priceUsd: unit,
//                     mediaUrl: PLACEHOLDERS[i % 6], parentId }
//   rpc fn_charge_and_generate → on 'insufficient_balance' → 402
//   → { items: rows.map(toDto), balanceUsd: rpc fn_balance }
Deno.serve(app.fetch);
```

Full implementation writes every route with explicit zod-free validation (hand checks, 400 on failure), snake_case→camelCase DTO mapping, and the same 6-URL Unsplash placeholder pool from `GenerationStore`.

- [ ] **Step 2:** Deploy via MCP (`deploy_edge_function` with `api/index.ts` + `_shared/*` files).
- [ ] **Step 3: Verify with curl:** no token → 401; garbage token → 401; (real-token tests happen in Task 7 once a user exists). `get_logs` service `edge-function` shows boots clean.

---

### Task 5: Angular auth + API client

**Files:**
- Create: `src/app/core/api/api-service.ts`, `src/app/core/api/dtos.ts`, `src/app/core/supabase/supabase-client.ts`
- Modify: `src/app/core/auth/auth-service.ts` (real), `src/app/core/auth/auth-guard.ts` (async), `src/app/features/auth/login-page.{ts,html,css}` (Google + email/password + signup), `package.json` (`@supabase/supabase-js`)
- Test: `src/app/core/api/api-service.spec.ts`

**Interfaces:**
- Produces: `ApiService.get<T>(path)`, `.post<T>(path, body)`, `.patch/.put/.delete`; throws `ApiError { code, message, status }`. `AuthService`: `session` signal, `signInGoogle()`, `signInEmail(email, pw)`, `signUpEmail(email, pw)`, `signOut()`, `isAuthed`, `userEmail` computed. DTOs per Task 4.

- [ ] **Step 1:** `npm install @supabase/supabase-js`. `supabase-client.ts`: single `createClient(environment.supabaseUrl, environment.supabaseAnonKey)` export.
- [ ] **Step 2: Failing test** — ApiService maps error body to `ApiError` and attaches bearer token (mock fetch + fake session provider):

```typescript
it('maps error body to ApiError with status', async () => {
  globalThis.fetch = vi.fn().mockResolvedValue(new Response(
    JSON.stringify({ error: { code: 'insufficient_balance', message: 'Top up' } }), { status: 402 }));
  const api = new ApiService(() => Promise.resolve('tok'));
  await expect(api.post('/generations', {})).rejects.toMatchObject({ code: 'insufficient_balance', status: 402 });
  expect((globalThis.fetch as any).mock.calls[0][1].headers['Authorization']).toBe('Bearer tok');
});
```

(Constructor takes a token-provider function so tests need no Supabase; Angular DI wraps it.)

- [ ] **Step 3:** Implement ApiService + DTO interfaces. AuthService rewires: session signal from `onAuthStateChange` + `getSession()` on boot; `signInGoogle()` → `signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + '/app' } })`; guards return `Promise<boolean>` awaiting session restore.
- [ ] **Step 4:** Login page: Google button (logo from `/logos/google.svg`), divider, email+password form with Sign in / Create account toggle, error line from thrown auth errors. Stub note removed.
- [ ] **Step 5:** Tests + build green. Manual: email signup against live project creates `profiles` row (verify via `execute_sql`).

---

### Task 6: Stores go API-backed

**Files:**
- Modify: `src/app/core/ledger/ledger-service.ts`, `src/app/core/generations/generation-store.ts`, `src/app/core/preferences/preferences-service.ts`, `src/app/features/workspace/workspace-page.ts`, `src/app/features/editor/editor-page.ts`, `src/app/features/settings/*` (billing/profile/usage tabs), `src/app/shared/profile-menu/profile-menu.ts`
- Test: existing suites stay green; `ledger-service.spec.ts` rewritten against mocked ApiService.

**Interfaces:**
- Consumes: ApiService + DTOs (Task 5).
- Produces: same public store shapes as today — `balanceUsd`, `entries`, `items`, `byId`, `chainFor` — components largely untouched. New: `GenerationStore.create(req): Promise<void>` replacing `add` (calls POST, applies `{ items, balanceUsd }`); `LedgerService.applyBalance(balanceUsd, entries?)`; `refresh()` loaders called after login.

- [ ] **Step 1:** LedgerService: signals fed by `GET /ledger` + `GET /profile.balanceUsd`; `charge()` deleted (server charges). Topup buttons become disabled with "Stripe arrives in phase 2" hint (billing tab + profile menu + topbar).
- [ ] **Step 2:** GenerationStore: `items` from `GET /generations`; `create()` posts and prepends returned items + pushes balance to LedgerService; `remove()` → DELETE; `chainFor` unchanged (client-side over loaded items); placeholder pool removed (server assigns).
- [ ] **Step 3:** PreferencesService: load from `GET /profile.prefs`, `update()` → `PUT /prefs` + local cache for instant boot.
- [ ] **Step 4:** Workspace/editor `onGenerate`/`applyEdit`/`upscale`/`variation` → `store.create(...)` with async pending state on the button; 402 ApiError → sonner toast + top-up nudge; profile tab delete-account → `DELETE /profile` then signOut.
- [ ] **Step 5:** Delete all localStorage stub persistence (session shim, `vansen.ledger`, `vansen.generations`; prefs cache stays). Tests + build green.

---

### Task 7: Auth config + E2E verification

**Files:** none (live verification); Modify: `vansen.md` (Foundation shipped note), `CLAUDE.md` (project ref + env note)

- [ ] **Step 1: USER ACTIONS (blocking, request explicitly):** in Supabase dashboard — (a) Auth → Providers → Google: paste OAuth client id/secret from Google Cloud Console (redirect URI shown in dashboard); (b) Auth → Sign In / Up: disable "Confirm email" for now (solo-user phase). Wait for confirmation.
- [ ] **Step 2:** E2E walk (preview + curl): email signup → profile row (execute_sql); sign in; display name PATCH persists; prefs survive reload; `POST /generations` → 402 at $0.
- [ ] **Step 3:** Charge-path proof: `execute_sql` insert `topup` +20.00 for owner account; generate (batch 1 + batch 4), edit w/ parentId, upscale; verify ledger sums, provenance, `GET /profile` balance matches; then delete test ledger rows + generations.
- [ ] **Step 4:** RLS proof: direct PostgREST query with anon key + user JWT (`curl <url>/rest/v1/ledger_entries -H apikey:<anon> -H "Authorization: Bearer <user jwt>"`) → empty/denied.
- [ ] **Step 5:** Google SSO click-through (after Step 1). Delete-account walk. `get_advisors` security re-run. vansen.md + CLAUDE.md notes. Full vitest + build green.

---

## Self-review notes

- Spec coverage: §4→T1, §5→T2, §7→T3, §6→T4, §8→T5/T6, §9→T7. Java-swap constraints embedded in T4 (REST + RPC) and T5 (apiBaseUrl, DTOs).
- No commit steps (user rule). No trial-credit code ships (T7 uses manual SQL, removed after).
- Type consistency: DTO names shared T4↔T5↔T6; RPC signature T2 matches T4 caller; enums single-source via T3.
