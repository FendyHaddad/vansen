# Vansen MVP Phase 1 — Foundation (Supabase + Auth + API Gateway)

Date: 2026-07-07
Status: approved in brainstorming; pending user review of this document
Prerequisite reading: `vansen.md` (product spec), `2026-07-05-workspace-redesign-design.md`

## 1. Goal

Replace every localStorage stub with real infrastructure: Supabase project, Postgres
schema, auth (Google SSO + email/password), and an API-gateway Edge Function that owns
all data access. After this phase the app runs against a real backend end-to-end;
generation output is still placeholder media and balances stay at $0 until Stripe
(phase 2).

## 2. Phasing (decided)

1. **Foundation — this spec.**
2. **Money** — Stripe checkout (first top-up $20 mixed cart: $15 credits + $5/mo Studio
   subscription), later top-ups, webhooks → ledger, Studio lifecycle + purge sweep,
   promo codes (Stripe-native coupons preferred; ledger already has a `promo` type).
3. **Generation** — dispatch Edge Function with moderation gate, real provider APIs,
   Storage buckets, realtime/polling job status, `jobs`/`models`/`moderation_events`
   tables.

No trial balance in Foundation (decided): the only user is the owner; charge-path
verification uses a temporary manual ledger credit that is removed after testing.

## 3. Architecture (Approach 2 — API gateway, decided)

```
Angular ──supabase-js (auth only)──► Supabase Auth (Google SSO, email/password, JWT)
Angular ──fetch + Bearer JWT───────► Edge Function `api` (Hono router)
                                        │ verify JWT → userId
                                        │ recompute prices server-side
                                        │ call Postgres RPCs (atomic money logic)
                                        ▼
                                     Postgres — RLS deny-all; service-role only
```

**Java-swap constraint (explicit requirement):** everything must be swappable to a Java
backend later.

- REST resource routes map 1:1 to future Spring controllers.
- All money/state logic lives in Postgres RPCs — survives any backend swap untouched.
- Angular talks to one `apiBaseUrl`; swap = change one env value.
- Supabase-issued JWTs verify via standard JWKS; a Spring app can validate the same
  sessions. Auth remains Supabase even after a swap.
- No Supabase client types in Angular data code — own DTO interfaces only. The route
  contract in §6 is the migration contract.

Client's ONLY direct Supabase surface is auth (`signInWithOAuth`, `signInWithPassword`,
`signUp`, session refresh). Data always goes through the API. Tables have RLS enabled
with zero policies for `anon`/`authenticated` — direct queries fail even with the anon
key; only the function's service-role reaches data.

Realtime: none in Foundation. Stub generation resolves synchronously in the POST
response. Phase 3 chooses polling vs realtime for live jobs.

## 4. Supabase project

- Org: Vankode (`oxblpifbnmlgiypkygdk`), project name `vansen`, region `ap-southeast-1`.
- Cost confirmed $0/month (user approved 2026-07-06).
- Created + configured via Supabase MCP (migrations, function deploy, keys).
- User manual action: create Google Cloud OAuth client (id + secret) for the Google
  provider; redirect URLs include `http://localhost:4200`.

## 5. Postgres schema (Foundation — 4 tables)

Enums are TEXT + CHECK constraints (cheap to evolve), mirroring the shared enums file
(§7). Balance is always `SUM(ledger_entries.amount_usd)` — never a stored column.

```sql
profiles (
  id uuid primary key references auth.users on delete cascade,
  display_name text,
  strikes int not null default 0,
  prefs jsonb not null default '{}',
  created_at timestamptz not null default now()
);

ledger_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles on delete cascade,
  type text not null check (type in ('topup','generate','edit','upscale',
    'studio_fee','trial_credit','promo','refund')),
  amount_usd numeric(10,2) not null,   -- signed: + credit, − debit
  family_id text,
  note text,
  created_at timestamptz not null default now()
);
-- index: (user_id, created_at desc)

generations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles on delete cascade,
  kind text not null check (kind in ('image','video')),
  family_id text not null,
  family_name text not null,
  op text not null check (op in ('generate','edit','upscale','variation')),
  prompt text not null,
  settings jsonb not null default '{}',
  price_usd numeric(10,2) not null,
  status text not null check (status in ('pending','done','failed')),
  media_url text not null,
  parent_id uuid references generations on delete set null,
  created_at timestamptz not null default now()
);
-- index: (user_id, created_at desc)

subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references profiles on delete cascade,
  plan text not null check (plan in ('studio','studio_pro')),
  status text not null check (status in ('active','canceled','expired')),
  current_period_end timestamptz,
  stripe_subscription_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

Plans are extensible (`studio_pro` reserved now — decided after "what if we have Studio
Pro"). Foundation UI: no subscription row → "Studio — inactive" badge, nothing
enforced, no purge. Phase 2 activates meaning.

**RPCs (SECURITY DEFINER):**

- `fn_balance(p_user uuid) returns numeric` — sum of ledger.
- `fn_charge_and_generate(p_user uuid, p_amount numeric, p_type text, p_items jsonb)
  returns setof generations` — one transaction, per-user advisory lock
  (`pg_advisory_xact_lock(hashtext(p_user::text))`): balance check → negative ledger
  entry → insert N generation rows (batch) → return rows. Raises `insufficient_balance`
  when short; API maps it to 402.
- `fn_delete_account(p_user uuid)` — deletes profile cascade; the API then removes the
  auth user via the admin API.
- `handle_new_user()` trigger on `auth.users` insert → creates the profiles row.

Deferred tables (by phase): `webhook_events`, `promo_codes`, `promo_redemptions`
(phase 2); `jobs`, `models`, `moderation_events` (phase 3).

## 6. API surface (Edge Function `api`, Hono router)

All routes JWT-authed. CORS: `http://localhost:4200` + future domain. Uniform error
body `{ "error": { "code": string, "message": string } }`. Status codes: 401 bad/absent
token, 400 invalid payload/family/settings, 402 insufficient balance, 404 not found or
not owned.

```
GET    /profile           → { profile, balanceUsd, subscription | null }
PATCH  /profile           → { displayName }
DELETE /profile           → wipes account (RPC + auth admin delete)
PUT    /prefs             → full prefs object (jsonb)
GET    /ledger            → entries, newest first, limit 100
GET    /generations       → library list, newest first
POST   /generations       → { familyId, op, prompt, settings, batch, parentId? }
                            → { items: GenerationDto[], balanceUsd }
DELETE /generations/:id
```

**Server is the price authority.** The client never sends a price. The function
recomputes provider cost + margin from `settings` using the shared catalog and charges
that. Edit/upscale/variation are `POST /generations` with `op` and `parentId` — no
separate endpoints. Upscale pricing uses the shared `UPSCALER` constant. Foundation
stub: created rows get `status='done'` immediately and a server-chosen placeholder
media URL (same verified Unsplash pool).

## 7. Shared code (single source of truth)

- `src/app/core/enums.ts` — const-object pattern for every domain enum
  (`LedgerType`, `GenerationOp`, `GenerationStatus`, `MediaKind`, `SubscriptionPlan`,
  `SubscriptionStatus`). No string literals in app code (user requirement). DB CHECK
  constraints mirror these values exactly.
- `supabase/functions/_shared/` — `enums.ts` and `catalog.ts` (model families + cost
  functions + PAYG margin) consumed by the Edge Function. Mechanism (decided): the
  Angular files are the masters; `scripts/sync-shared.mjs` copies them into
  `_shared/` (adding Deno-required `.ts` import extensions) and runs before every
  function deploy; a vitest asserts the copies are byte-identical modulo that
  transform, so drift fails CI. ONE definition of prices/enums governs both sides.

## 8. Frontend refactor

- `environment.ts`: `apiBaseUrl`, `supabaseUrl`, `supabaseAnonKey` (anon key is
  publishable by design; secrets never ship).
- `core/api/api-service.ts`: single typed fetch wrapper — Bearer JWT from Supabase
  session, uniform error parsing, `get/post/patch/put/delete`. All stores go through
  it; nothing else touches the network.
- `core/api/dtos.ts`: `ProfileDto`, `LedgerEntryDto`, `GenerationDto`,
  `SubscriptionDto`, request payloads. The JSON contract, Java-proof.
- `AuthService`: real — `signInWithOAuth('google')`, `signInWithPassword`, `signUp`,
  session signal via `onAuthStateChange`; guards await session restore.
- `LedgerService` / `GenerationStore`: same public shape (components unchanged), now
  API-backed: load after login, mutate via API, update signals from responses
  (`POST /generations` returns items + new balance → one round trip updates both).
  localStorage persistence deleted.
- `PreferencesService`: server-backed (`PUT /prefs`), local cache for instant startup.
- Login page: real Google button + email/password with sign-up toggle + error states.
- Settings: display name PATCH, delete account, ledger/usage from API.
- Errors: sonner toasts; 402 → top-up nudge. No client-side money math remains.

## 9. Verification

- Existing vitest suite stays green; new unit tests for api-service error mapping and
  enums integrity (CHECK values == enum file values).
- Live E2E walk: email signup → profile row exists; Google sign-in; display name save;
  prefs persist across reload; `POST /generations` → 402 with $0 balance; temporary
  manual SQL credit on owner's account → generate/edit/upscale/batch succeed, ledger
  sums correct, provenance chain intact; test entries removed; delete account wipes
  everything.
- Direct table query with anon key must FAIL (RLS deny-all proof).

## 10. Out of scope (Foundation)

Stripe, promo codes, Studio enforcement, purge sweep (phase 2). Real providers,
Storage, realtime, moderation gate, strikes enforcement (phase 3). Hosting/deploying
the Angular app (still localhost). NgRx (decided against; signal stores stay).
