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

### Multi-tenant provider key policy (decided 2026-07-06)

Vansen holds ONE org account/key per provider (plus fal.ai as aggregator for
Seedream/Seedance/Kling/FLUX). Users never see or touch keys — they call our dispatch
Edge Function, which checks balance and calls the provider with our key. This is the
standard wrapper model (OpenRouter/fal/Higgsfield); providers permit apps, they forbid
raw key sharing — which we never do.

**Org-ban prevention (top priority — one user's bad prompt must never burn the org key):**

1. **Pre-dispatch moderation gate.** Every prompt runs through a moderation check inside
   the dispatch function BEFORE any provider call. Flagged prompt → job rejected, no
   provider request ever happens, strike recorded. The provider never sees the bad
   request, so there is nothing to ban.
2. **Per-user safety identifiers.** Every provider request carries a hashed user id
   (OpenAI `safety_identifier`; equivalent metadata where supported). Providers then
   throttle/flag that end user, not the org account. Built for exactly this case.
3. **Strike system.** `users.strikes` counter: flagged prompt = strike; N strikes =
   auto-suspend generation, manual review. Repeat abusers banned before a provider
   ever complains.
4. **Per-user rate limits** on dispatch (RPC-enforced), so no single account can spray
   requests.
5. **Provider-native safety settings** always on (Gemini safety settings, OpenAI
   moderation defaults) — second net behind our gate.
6. **Kill switch per model/provider.** `models.enabled` flag — if a provider raises any
   abuse signal, disable dispatch for that provider instantly while investigating.
7. **Full audit trail.** Every job row stores user id, prompt, model, moderation verdict,
   provider request id — we can answer any provider abuse inquiry with the exact user
   and act on it.

Cost-runaway containment: prepaid balance is a hard per-user cap by construction; add a
global daily spend alarm per provider and Stripe Radar on top-ups.

### Account-sharing prevention

One Vansen account = one person. Balance is shared-by-nature (drains fast if shared —
partial self-limiting), but Studio is flat $5/mo, so enforce:

- **Concurrent session cap.** Supabase Auth tracks refresh tokens/sessions; allow max 2
  active sessions (laptop + phone). New device beyond cap forces logout of oldest.
- **Session heuristics.** Flag accounts with parallel activity from distant IPs /
  impossible travel or >3 devices per week → soft warning, then generation pause
  pending re-verification (email OTP).
- **Dispatch concurrency guard.** One account cannot run generations from two IPs at
  the same second repeatedly — RPC counts overlapping dispatch origins; sustained
  overlap = sharing signal, feeds the same flag.
- No password sharing enforcement theater beyond that — heuristics + session cap catch
  the economic abuse (Studio fee split), and prepaid balance means shared generation
  spend still gets paid for.

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

## Status (2026-07-09)

**Phase 3b — Studio editing panel shipped** (spec: `docs/superpowers/specs/2026-07-09-studio-editing-panel-design.md`):
Photoshop-lite editing inside the workspace: clicking Edit swaps the library grid for a
canvas viewport (old `/app/edit/:id` route absorbed); left AI rail stays, new right
Studio panel is Studio-subscriber-gated (locked + $5/mo upsell otherwise). Free local
tools run in-browser (Canvas2D engine in `src/app/core/editing/`, Web Worker + main-thread
fallback): crop/rotate, brightness/contrast/saturation, sharpen, smooth, liquify warp,
content-aware spot heal (OpenCV.js Telea inpaint, ~3MB lazy chunk on first use), mask.
Paid AI tools sit in a separate "AI Tools · uses balance" section with fixed retail
price chips (NOT the PAYG margin formula): Remove Object $0.10, Generative Fill $0.10,
Expand $0.10 (client pads canvas 25%/side + border mask), Remove Background $0.05
(margins: 2× on fill ops, 25× on bg). All ride the Phase 3a pipeline — `op:'edit'` +
`familyId: edit-remove|edit-fill|edit-expand|edit-bg`, fal FLUX-fill/BiRefNet, jobs,
single refund, moderation, kill-switch rows per tool (verified live: save → $0 version,
maskless remove → 400, edit-bg charged $0.05 → done). Local edits persist via
`POST /edits/save` — moderated, then stored as a $0 "Studio Edit" version chained by
`parent_id`. Video mode is a locked "coming with Pro" teaser; the panel's Studio|Pro
switch shows Pro locked. Video generation moved to Phase 4b.

**Phase 3a — Image generation shipped, live** (spec: `docs/superpowers/specs/2026-07-09-mvp-phase3a-generation-design.md`):
Real image generation for all four image families through provider adapters
(`supabase/functions/_shared/providers/`): GPT Image generate + edits (OpenAI, inline),
Seedream + FLUX + clarity upscaler (fal queue, polled via `GET /jobs`), Nano Banana
(Google Gemini, inline — blocked until the Google AI key gets billing; free tier has
zero image quota). Generations insert `pending`, jobs dispatch, outputs land in the
private `media` bucket with 7-day signed URLs (direct bucket access rejected — verified).
Failures refund exactly once via `fn_fail_job` (`ledger_refund_once` unique index,
verified live); stale jobs sweep every 5 min. Safety: OpenAI omni-moderation gates every
prompt and upload BEFORE charge and BEFORE any provider call (drill verified: zero jobs
created on flagged prompt); 2 strikes = suspension (429 on generate + upload), no refund
of balance; full evidence retained in `moderation_events` (prompt, quarantined upload,
category scores, `resolution` field) so a human can overturn wrong flags — reinstate
drill verified. Per-model kill switch in `models` table (503 + greyed UI, verified).
`safety_identifier`/`user` hash sent to providers, never the raw user id. Upscale is now
fal clarity-upscaler (`upscaler`, $0.06) — Magnific dropped. Video families stay
disabled until phase 4b. Provider keys live only in Edge Function secrets:
`GOOGLE_AI_API_KEY`, `OPENAI_API_KEY` (also powers moderation), `FAL_API_KEY`.

**Phase 2 — Money shipped, test mode** (spec: `docs/superpowers/specs/2026-07-07-mvp-phase2-stripe-design.md`):
Stripe hosted checkout live — first purchase $15 ($10 credits + $5/mo Studio mixed cart),
top-ups from $10, signature-verified `stripe-webhook` function as sole `topup` writer,
`webhook_events` dedupe + `ledger_entries.stripe_ref UNIQUE` (double-credit impossible,
verified), `/billing/reconcile` self-heal (verified restoring a deleted credit,
idempotent), Billing Portal for cancel/card/invoices, 30-day-grace purge cron (dry-run
verified), account deletion cancels the Stripe subscription. Promo codes = Stripe-native
coupons, zero code. Live keys flip at phase 4 once bank authorization clears.

**MVP Foundation shipped** (spec: `docs/superpowers/specs/2026-07-07-mvp-foundation-design.md`):
Supabase project `bnorhcxhvxydkgvcxjad` (ap-southeast-1), 4-table schema + RPCs with
RLS deny-all + gateway-only execute, `api` Edge Function (Hono) as the sole data path,
real auth (email/password + Google pending OAuth credentials), Angular fully API-backed.
Generation output still placeholder media; balances $0 until Stripe (phase 2 — includes
promo codes for launch pricing). Phase 3 wires real providers + Storage + moderation gate.

## Delivery order

1. Full Postgres schema (tables, columns, RLS policies, RPCs for ledger). Stop, review
   before writing code.
2. Edge Function set: dispatch, provider-webhook, stripe-webhook, timeout-sweep,
   purge-sweep (deletes library for lapsed/canceled subscriptions past period end).
3. Angular app: auth, model picker, generate flow with Realtime job status, credit
   balance, library, Stripe checkout.
