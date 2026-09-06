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
- **As built (2026-07):** the client polls `GET /jobs` (`job-poller.ts`) instead of
  Realtime — deliberate simplification, see `CLAUDE.md`. Spec intent above kept for
  reference.
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

Lived at Angular route `/admin/pricing`; moved 2026-07-12 to the separate
`vankode-backoffice` repo (reads Vansen through its own service key). Derives credits-per-model from provider cost,
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

**Subscription plans (repriced 2026-07-13, spec
`docs/superpowers/specs/2026-07-13-credit-subscription-pricing-design.md`):**

| Plan | Price | Credits/cycle | Video generation |
| --- | --- | --- | --- |
| Studio | $15/mo | 1,500 | Not allowed — image models + full editing suite |
| Pro | $30/mo | 3,750 | Allowed (Phase 4b, still locked) |
| Owner | internal, hidden | unlimited (plan bypass, ledger still written) | Pro access |

- 1 credit = $0.01 Studio retail. Charge = `ceil(providerCost / (1 − 0.40) × 100) × batch`;
  AI edit tools fixed (Remove/Fill/Expand 10 cr, Remove BG 5 cr, Upscale 7 cr); local
  tools free. Launch promo: first 2 cycles $10 / $25 with full credit grant.
- Two ledger buckets: `plan` (reset to grant each cycle, spent first) and `pack`
  (add-on packs $10/25/50/100 with 0/5/8/10 % bonus, roll over while subscribed, die 30
  days after lapse). Refunds return to the bucket drawn from. Non-subscribers browse only.
- Plan gate enforced server-side (`modelGate()` checks `models.min_plan` against the
  caller's active plan before any charge). `subscriptions.plan` ∈ `studio | pro | owner`.
- iOS non-US/EU storefronts sell through Apple IAP (Lane B, ~+15 % price sheet); see
  Status 2026-07-19.

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

### 7. Video (Phase 4b)

- Pro-only: the Video tab is locked for Studio/free users (click → upgrade dialog);
  Studio-preview local tools are unaffected.
- Five families: Veo 3.1 (Google, standard/fast/lite), Gemini Omni Flash 1.1 (Google),
  Kling 3.0 Pro (fal), Runway Gen-4.5 (Runway direct), Seedance 2.5 (fal).
- Modes, gated per family: text→video (t2v), image→video (i2v), reference→video
  (ref2v, up to 3 references), keyframes (first + last frame), extend (continue a
  finished clip), edit (multi-turn edit, Omni only). Aspect ratios `16:9 | 9:16 | 1:1`;
  hidden for i2v and keyframes (ratio follows the input frame).
- Storage: video output always goes to Cloudflare R2 (`generations.storage_backend =
  'r2'`), never Supabase Storage — images stay on Supabase Storage. Poster frames are
  captured client-side (seek to 0.5 s, canvas, JPEG) and uploaded once per generation;
  library falls back to a dark tile + play icon until the poster lands.
- Waiting UX (the user may leave the page — a notification fires on completion):
  phase labels `Queued`, `Rendering`, `Saving`, `Done`; the progress bar eases to 90 %
  and then reads "Almost there…"; "You can leave this page. We'll notify you when
  it's ready."; past twice the expected time it reads "Taking longer than usual —
  still working."; the browser tab title prefixes `(n) Rendering…`; a top-bar chip
  reads "Rendering N video(s)".
- Cancel: available where the provider supports it (fal while queued, Runway any
  time); Veo/Omni jobs cannot be cancelled once started. Cancelling or any provider/
  timeout failure refunds credits exactly once.
- Caps: 3 concurrent pending video jobs per user, and a $40/day provider-spend cap
  per user (rolling 24 h) — both return a 429 with a clear toast, not a silent fail.

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

## Status (2026-09-06)

Deployed: `api` v41 (2026-08-14, in sync with backend HEAD apart from Video — see below),
`stripe-webhook` v12, `appstore-webhook` v2. Gates green: `ng build` clean, vitest + deno
tests (counts in `docs/superpowers/punchlist.md`). Recent commits (07-24 → 09-05) are
UI/auth fixes plus AI Sharpen; Video (Phase 4b) is code-complete this session but not
yet rolled out.

**Video (Phase 4b) — code complete, rollout pending (2026-09-06):** five families
(Veo 3.1, Gemini Omni Flash 1.1, Kling 3.0 Pro, Runway Gen-4.5, Seedance 2.5),
full mode matrix, R2 storage, waiting UX, caps and refunds all implemented per
`docs/superpowers/specs/2026-09-05-video-generation-phase4b-design.md`. Still pending
(user, needs Cloudflare/Supabase credentials + a live Pro account): apply migration
`0016_video.sql`; set secrets `RUNWAY_API_KEY`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, `R2_BUCKET`; create the R2 bucket + CORS; redeploy `api`; enable
each family in `models` one at a time and smoke it live. See
`docs/superpowers/punchlist.md` for the itemized rollout list.

**Open items (carry-forward):**
- Stripe still TEST mode; live keys flip once bank authorization clears.
- Trend thumbnails not generated (`scripts/gen-trend-thumbs.mjs`, ~$0.50 OpenAI);
  `public/trends/` missing so trend tiles render alt text.
- Persona live smoke never run (~$2.30 fal); analytics manual smoke pending
  (`docs/superpowers/punchlist.md`).
- Leaked-password protection waits on Supabase Pro upgrade.
- Not started: i18n (en + ms), session cap / account-sharing heuristics, dispatch rate
  limit, daily spend alarm, CI. Denoise / Colorize need offline ONNX export + self-host.
- Legal pages are AI-drafted; attorney review (Malaysia + EU/US) outstanding.
- Known scope reductions in Video: "From library" picker for video reference slots was
  removed (needs gateway `referenceIds` support, see `reference-drop.ts`); the
  `provider_blocked` client copy ("Provider declined this prompt. Credits refunded.")
  is a placeholder pending a wording decision.

**AI Sharpen shipped (2026-09-05)** (spec `docs/superpowers/specs/2026-09-05-ai-sharpen-design.md`):
Pro rail tool `aisharpen` → `core/editing/engines/deblur-engine.ts`, NAFNet GoPro deblur ONNX
(OpenCV zoo, MIT, ~88 MB first-use download into the shared `vansen-models` cache). Tiled
256 px core + 32 px overlap, edge-padded to multiples of 16, WebGPU with `saneTile` hot-swap
to wasm, same 16 MP ceiling as Upscale. Same-size output, alpha copied through. Free,
on-device, no credits.

**Style presets, avatar personas, trends, client analytics shipped (2026-07-24)**
(specs: `2026-07-24-style-presets-design.md`, `2026-07-24-avatar-persona-design.md`;
migrations 0013–0015): 20 style presets (`src/app/core/catalog/style-presets.ts` →
`_shared/style-presets.ts` via `sync-shared`, drift-guarded); server appends the style
modifier before moderation, stored prompt stays clean, thumbs in `public/styles`.
Personas = trained FLUX LoRA on fal (5–20 photos, fixed 350 cr, Studio 2 / Pro 5 slots,
self-attested consent); `GET/POST/DELETE /personas`, `POST /personas/:id/train`,
hidden `persona` family routes generation through fal flux-lora with trigger word
injected server-side. 12 curated trends (`trend-presets.ts`) prefill the prompt box.
Analytics: `x-vansen-client` header → `client` column on generations / personas /
app_errors, `POST /errors` logs client errors, `backoffice_feature_usage(p_days)` RPC
feeds the backoffice feature page.

**Mobile lane — FCM push + iOS IAP shipped (2026-07-18/19)** (migrations 0011, 0012):
`POST/DELETE /devices` stores FCM tokens; `_shared/push.ts` (HTTP v1, service-account
JWT) pushes `generation_done | generation_failed` on job settle. `GET /billing/lane`:
Android + US/EU iOS = Lane A (web Stripe), other iOS storefronts = Lane B (IAP) when
enabled, else C. IAP: `_shared/iap-products.ts` price sheet (+~15 % over web, credit
grants identical, guarded by test), `POST /iap/verify`, `appstore-webhook` = ASSNv2
consumer and sole `iap` ledger writer (Apple JWS x5c chain verify, `webhook_events`
dedupe on notificationUUID + `iaptx:` marker shared with verify, `fn_iap_clawback` on
refund, `subscriptions.iap_original_transaction_id`). Mobile deep-link return targets for
Stripe checkout. Flutter client lives in a separate repo (`~/StudioProjects/Vansen-mobile`).

**Age gate + legal pages shipped (2026-07-17)** (specs `2026-07-17-age-gate-design.md`,
`2026-07-17-legal-pages-design.md`; migration 0008_age_gate; `api` v29): global 18+,
neutral date-of-birth screen at `/onboarding` after any login (covers Google OAuth),
`POST /profile/age` stores `birth_date`; under-18 → two-step confirm → account deleted +
signed out. `ageGuard` / `onboardingGuard` protect `/app`. Legal: `/legal/terms`,
`/legal/privacy`, `/legal/acceptable-use`, footer links, clickwrap notice at sign-in.
Entity Vankode Technology (Malaysia), governing law Malaysia, contact support@vankode.com,
all sales final.

**Credit-based repricing, owner tier, notifications, onboarding tour (2026-07-13 →
07-15)** (specs `2026-07-13-credit-subscription-pricing-design.md`,
`2026-07-13-owner-tier-lock-pass-design.md`,
`2026-07-13-notifications-and-onboarding-design.md`; migrations 0007, 0008_credit_plans,
0009, 0010): supersedes the $15 first-purchase model — see Billing §5 for the plan table,
credit formula and two-bucket ledger. Billing routes: `/billing/subscribe | pack |
change-plan (pending_plan_change) | cancel (cancel_reason) | resume | portal | overview |
lane | reconcile`. Owner plan = hidden, unlimited via plan bypass in
`fn_charge_and_generate` (charge rows still written, balance goes negative by design);
granted from the backoffice. Pro lock pass: Pro-preview tools gated to `pro | owner`,
locked teaser otherwise. Notification center (bell, unread badge, toast; refund /
ready / moderation-blocked events, device-local) and spotlight onboarding tour
(auto-runs first workspace load, replayable). Backoffice split out 2026-07-12 into
`vankode-backoffice` (own service key; `/admin/*` routes and `backoffice-api` function
dropped from Vansen); `app_errors` surface there as notifications.

**Studio & Pro tools expansion shipped (2026-07-11)** (spec
`2026-07-11-studio-pro-tools-expansion-design.md`): 17 filter presets, Dehaze,
Portrait Smooth, Magic Erase (SlimSAM → dilate → MI-GAN); heal moved from OpenCV Telea to
MI-GAN inpainting (28 MB ONNX, lazy). Pro tools: enhance / levels / clone / retouch /
perspective (pure ops) + ONNX engines Cut Out (ISNet fp16), Bokeh (Depth Anything V2
small), Upscale 2× (Swin2SR), Smart Select (SlimSAM-77), all through shared
`model-loader.ts` and Cache Storage `vansen-models`. Perf: colour/filter previews on the
≤1100 px proxy, slider input coalesced per frame (`preview-scheduler.ts`). License policy
enforced (RMBG, AGPL ISNet mirror, GFPGAN, CodeFormer, MODNet banned).

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
(Google Gemini, inline; `fast|default|pro` → gemini-2.5-flash-image / gemini-3.1-flash-image /
gemini-3-pro-image — the 2026-08 free-tier 429s are resolved, Nano Banana Pro generates fine). Generations insert `pending`, jobs dispatch, outputs land in the
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
