# Vansen — AI Generation Broker (Higgsfield-style wrapper)

## What we're building

Web app wrapping multiple third-party AI generation APIs (Google, OpenAI, ByteDance, etc.)
for image and video generation. Users buy/subscribe for credits, pick a model, generate,
keep private library of results. We do not train or host models — we broker jobs to
external providers and add UX + credit + billing layer on top. Real product, intended to
monetize.

## Stack (decided — do not substitute)

**Frontend:** Angular — latest stable, Angular 22 (released June 2026, active support).
Angular 21 LTS (supported until May 2027) only acceptable fallback if critical dependency
isn't v22-ready. Modern Angular throughout: standalone components, signals, signal-based
inputs, new control flow (@if/@for), zoneless change detection, Signal Forms (stable).
No NgModules, no Zone.js in new code.

**UI styling:** as close to shadcn as possible. shadcn is React-only, so use spartan/ui
(spartan-ng) — stable, exact Angular port. Two layers: @spartan-ng/brain (headless,
accessible behavior primitives) + Helm (copy-in Tailwind styles we own and customize).
Tailwind v4, CSS variables for theming, lucide icons (via @ng-icons/lucide). "New York"
style. Copy Helm components into project (shadcn philosophy — own the code), don't wrap
a black-box library. If available in environment, use spartan MCP server (@spartan-ng/mcp)
and spartan agent skill for up-to-date component code.

**Backend + infra:** Supabase — Postgres, Auth, Realtime, Storage, Edge Functions
(Deno/TypeScript).

**Payments:** Stripe (both one-time credit packs AND subscriptions).

No separate Java/Spring backend. All server logic lives in Edge Functions.

## Core architecture (requirements, not suggestions)

### 1. Provider adapter pattern — heart of the system

Adding a new model MUST be a DB row + config only, zero new code.

- A `providers` table and a `models` table describe every model as DATA: provider,
  endpoint, input param schema, output shape, USD cost, credit price, webhook format,
  capability (text-to-image / text-to-video / image-to-video).
- A single generic dispatch Edge Function reads the model config and submits the job.
- No per-provider if/switch branching in business logic. Provider quirks described in
  config, normalized into one internal job schema.

### 2. Async job lifecycle — webhook + realtime, NOT polling

- User submits → Edge Function creates a `jobs` row (status `reserved`) → submits to
  provider.
- Provider calls our webhook Edge Function on completion/failure.
- Webhook updates the `jobs` row; Supabase Realtime pushes update to Angular client.
- Frontend subscribes to its own jobs via Realtime — no client-side polling loops.
- Handle timeouts: job with no webhook after N minutes marked failed by scheduled
  function.

### 3. Credit ledger — reserve-on-submit, settle-on-success

- Append-only `credit_ledger` table (never mutate balances directly; balance = sum of
  ledger).
- On submit: write reserve entry (holds credits).
- On success (via webhook): settle the reservation (credits consumed).
- On failure/timeout: release the reservation (credits returned to user automatically).
- All ledger mutations happen inside Postgres transactions / RPCs so concurrent jobs
  can't double-spend. **This is the #1 correctness requirement.**

### 4. Pricing engine

- Each model row carries a real USD cost (editable) and a credit price (what we charge).
- Margin derived and visible in admin view; prices change without redeploying.
- Example intent: 2 credits = 1 image on expensive model, or 4 images on cheap one.

**Cost → Price → Profit calculator (built — internal admin tool).**

Lives at route `/admin/pricing` (Angular). Derives credits-per-model from provider cost,
target net margin, and amortized Stripe overhead — so we see per-model where we make or
lose money before setting credit prices.

Inputs (editable in UI): credit price (USD), target net margin (%), Stripe fee (%),
Stripe fixed fee (USD), credit pack price (USD).

Derived per pack:
- `pack_credits = pack_price / credit_price`
- `pack_stripe_fee = pack_price × stripe_percent + stripe_fixed`
- `overhead_per_credit = pack_stripe_fee / pack_credits` (Stripe fee amortized across
  the credits in a pack)

Per-model credit price:
- `credits = ceil( provider_cost / ( credit_price × (1 − target_margin) − overhead_per_credit ) )`
- If `credit_price × (1 − target_margin) − overhead_per_credit ≤ 0` → target impossible
  (credit price too low for that margin); flagged in UI.

Per-model margin check (given charged credits):
- `gross = credits × credit_price`
- `net = gross − (credits × overhead_per_credit) − provider_cost`
- `net_pct = net / gross`
- UI color codes: profit (≥ target), thin (positive but under target), loss (negative).

Model catalog is a typed array today (`features/pricing/model-catalog.ts`) with real,
verified provider costs and availability per model. **This is the seed data for the DB
`models` table** (point 1) — same fields (provider, name, kind, unit, usd_cost). Once the
schema lands, the catalog moves to Postgres and this calculator reads/writes those rows
instead of the static array. Reseller-sourced costs (fal.ai / via Runway) are labeled in
the `unit` field; first-party provider costs (Google, OpenAI, Runway) are unlabeled.

**Workspace catalog (2026-07-05):** the user-facing workspace now runs on a family-based
catalog (`core/catalog/model-families.ts`) — 10 launch families (5 image, 5 video) with a
capability schema (versions, aspect ratios, resolutions, qualities, durations, image/mask
input) and per-settings cost functions. The flat `MODEL_CATALOG` stays as the admin-tool
seed data until both move to the DB `models` table. The workspace UI implements the PAYG
stub with a ledger (`core/ledger/ledger-service.ts`) that mirrors the future
`transactions` table: balance is always the sum of entries, never a stored number.

### 5. Billing

- Stripe for both credit packs (one-time) and subscriptions (refill credits on renewal).
- Stripe webhooks → Edge Function → `credit_ledger` top-up entries.
- Subscription renewal and cancellation reflected in ledger.

**Subscription tiers (decided):**

| Tier | Price | Credits/mo | Video generation |
| --- | --- | --- | --- |
| Tier 1 | $15/mo | 200 credits | Not allowed — image models only |
| Tier 2 | $30/mo | 500 credits | Allowed |

- Tier gate enforced server-side, not client-side: dispatch Edge Function checks caller's
  active subscription tier against `models.kind` (image vs video) before submitting job.
  Tier 1 subscriber attempting a video model job → rejected before reserve entry written.
- `subscriptions` table tracks user's active tier (`tier_1` / `tier_2`), Stripe
  subscription id, status, current period end.
- One-time credit packs remain independent of subscription tier and do not unlock video
  access by themselves — video access is a Tier 2 subscription gate, not a credit-balance
  gate.

### 6. Library

- Private per-user library of generations. No public gallery in v1.
- Outputs stored in Supabase Storage; jobs row references storage path.
- RLS everywhere: users only ever read their own jobs, ledger, and files.
- Store everything, full res, no compression/tiering (storage cost is small vs provider
  API cost, already inside margin math).

**Retention on subscription lapse (decided):**

- Subscription period = 30 days.
- User cancels before period end → access continues until period end (already paid for),
  library and generation still usable.
- At period end, if not renewed (canceled beforehand, or payment simply didn't go
  through / user didn't resubscribe) → purge: delete all storage files + library entries
  for that user.
- Scheduled function (alongside `timeout-sweep`) runs daily: find subscriptions with
  `status = canceled` or `status = expired` and `current_period_end < now()`, delete
  their Storage objects, delete/soft-delete their `jobs`/library rows.
- Purge is permanent — no grace period beyond the paid period itself. Warn user in UI
  before period end that library will be deleted if they don't renew.

## Security

- Supabase RLS on every user-facing table (jobs, ledger, library).
- Provider API keys and Stripe secrets live in Edge Function secrets, NEVER in client.
- Webhook endpoints verify provider/Stripe signatures before trusting payloads.

## Coding standards (Vankode standards — enforce strictly everywhere)

- Guard clauses and early returns. No nested if.
- Single-responsibility functions. Max three-word function names.
- No inline comments.
- Clean Architecture, feature-first folder structure.
- i18n dot-notation keys, max three words. Localization: en and ms.
- Typed everything (Angular + Edge Function TypeScript).
- Angular 22 idioms only: signals, @if/@for, standalone, Signal Forms, zoneless.
- UI built from spartan/ui Helm components (shadcn look). Don't hand-roll primitives
  spartan already provides; copy them in, style via Tailwind + CSS variables.

## Delivery order

1. Full Postgres schema (tables, columns, RLS policies, RPCs for ledger). Stop, review
   before writing code.
2. Edge Function set: dispatch, provider-webhook, stripe-webhook, timeout-sweep,
   purge-sweep (deletes library for lapsed/canceled subscriptions past period end).
3. Angular app: auth, model picker, generate flow with Realtime job status, credit
   balance, library, Stripe checkout.
