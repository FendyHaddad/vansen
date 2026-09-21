# Punchlist — as of 2026-09-22 (evening refresh)

Superseded in part by the release hardening plans P1–P9. The authoritative record
of what is proven is
[`plans/2026-09-20-release-evidence.md`](plans/2026-09-20-release-evidence.md);
the deployment procedure is
[`plans/2026-09-20-release-runbook.md`](plans/2026-09-20-release-runbook.md).
Where this file and those disagree, those win.

Automated gates at 2026-09-22: 574 vitest, 535 deno, 72 script tests, SQL and
concurrency gates against a database reset from empty (0001→0025), production
build clean. **`npm run verify` exits 0** with `VANSEN_LOCAL_DB` set.

Production at 2026-09-22 (read from `/manifest` and the function inventory):
`api` v59 at revision `ebdcbe2`, schema `0025`, catalog `2026-09-22.3`;
`job-worker` v14 (bundle still carries catalog `2026-09-21.1`), `cleanup-worker`
v13, `stripe-webhook` v26, `appstore-webhook` v16. Stripe is in TEST mode. All
five video families are `enabled = false`.

The full ordered list of what is still open, including six release blockers found
by the post-implementation review, is
[`plans/post-implementation-review.md`](plans/post-implementation-review.md)
("Consolidated pending list"). This file keeps only the owner-run items and the
engineering backlog; it does not repeat those blockers.

---

## 🔴 Needs your attention (paid or account-level — yours to run)

### 1. ~~Trend thumbnails not generated~~ — DONE 2026-09-22
All twelve generated with `gpt-image-1` (low quality, ~$0.50), converted to 160px webp in
`public/trends/`, each reviewed by eye. `npm run check:assets` reports 12/12. Regenerate
with:
```bash
OPENAI_API_KEY=… node scripts/gen-trend-thumbs.mjs public/trends
```
Mirrors `gen-style-thumbs.mjs`. → Personas plan Task 12 Step 3.

### 2. Persona live smoke (~$2.30 fal)
Train one persona end-to-end and generate with it. Endpoints and fal training/inference are
in the deployed bundle but have **never run live**. → Personas plan Task 12 Step 2.

### 3. Analytics manual smoke (free, needs web app + backoffice up)
1. Web → generate once → `select client, settings->>'trend' from generations order by created_at desc limit 1` shows `web`.
2. Web → apply a trend, edit prompt, generate → `settings.trend` = trend id.
3. DevTools: `throw new Error('smoke-client-error')` → `app_errors` row `source='client'`, `client='web'`.
4. Backoffice `/vansen/features` → style ranking + platform split; 7/30/90 toggle works.
5. Backoffice `/vansen/errors` → **Web** chip filters to the smoke error; badge reads `web`.
→ Analytics plan Task 9 Step 4.

### 4. Go-live blockers (account-level)
- **Stripe live keys** — still TEST mode; flip `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` /
  `STRIPE_STUDIO_PRICE_ID` once bank authorization clears, re-point the webhook endpoint.
- **Leaked-password protection** — Supabase toggle is Pro-plan gated; enable after upgrade.
- **Legal review** — Terms / Privacy / Acceptable Use are AI-drafted; attorney review
  (Malaysia + EU/US exposure) outstanding before heavy reliance.

---

## 🟡 Engineering backlog (unblocked, unscheduled)

- **Video (Phase 4b) rollout pending** — code complete, gates green, every family
  `enabled = false` (D7). Done since 2026-09-06: `0016_video.sql` applied, R2 bucket
  `vansen-media` created, the four `R2_*` secrets set, `api` redeployed. Still
  missing: bucket CORS, the `storage_config.r2_bucket` row, `RUNWAY_API_KEY`, and a
  live smoke per family (cheapest settings, cancel + refund, R2 object check) from
  the per-family checklist in the release runbook. Open product decisions carried
  with it: "From library" picker for video reference slots (needs gateway
  `referenceIds`, see `reference-drop.ts`); `provider_blocked` copy wording; whether
  client-captured poster JPEGs need their own moderation pass; whether `left-panel.ts`
  `hideAspect` should hide the ratio chip for every non-t2v mode or only Kling i2v.
  Video enablement is out of scope for the current web release.
- **Abuse controls from spec, not built** — concurrent-session cap / account-sharing
  heuristics and a dispatch/request-rate limit on the generation and upload routes.
  The daily provider-spend alarm now exists (`provider_burn` in `0025`).
- **i18n / D4** — spec calls for en + ms; nothing started. Needs an explicit
  English-only launch decision or the translation funded
  (`specs/2026-09-20-launch-locales.md`).
- **Catalog follow-ups** — price GPT reference images (input tokens at $8/1M are
  not charged today); drop `gpt-image` 1.5 and 2 per owner direction (`isDefault`
  still `'2'`); decide FLUX retail price or disable `flux`
  (`specs/2026-09-22-catalog-refresh.md` §13).
- **CI** — `.github/workflows/ci.yml` runs web, edge and database jobs on every
  push. Missing a `deno cache` step, so a cold runner can fail three edge test
  files fetching `jsr:@matmen/imagescript`.
- **Owner-requested revamps (last in order)** — self-hosted Supabase staging (cloud
  org is taken by production and `algawth`), clean-code revamp for AI-free
  maintenance, public website redesign, left toolbar redesign. Detail in the
  review's consolidated list, items 21–24.

---

## ✅ Done since last update (2026-09-06 → 2026-09-22)

- **Release hardening P1–P9 implemented** — gateway/input integrity, billing
  fulfillment RPC, catalog contract + drift checks, transactional settlement, durable
  dispatch via `job-worker`, durable deletion via `cleanup-worker`, client
  correctness, product-truth/recovery routes, release gates. Evidence:
  `plans/2026-09-20-release-evidence.md`; procedure: `plans/2026-09-20-release-runbook.md`.
- **Production caught up (2026-09-22)** — migrations through `0025` applied; `api`,
  both workers and both webhooks redeployed (the webhooks had been stale since July);
  `GET /manifest` and `GET /capabilities` live; `deploy.sh` added.
- **Catalog refresh `2026-09-22.3`** — Nano Banana fast moved off
  `gemini-2.5-flash-image` before Google's 2026-10-02 shutdown; `gpt-image` 1
  withdrawn, 2.5 Flare/Sunburst added; all four image families' costs verified
  against live vendor pages.
- **`npm run verify` + CI** — ten-check runner, pinned local test stack
  (`db:test:start|stop`, CLI 2.114.0, migration hash manifest), GitHub Actions
  pipeline. `supabase start` fixed (duplicate `0008` prefix, vault guards, analytics off).
- **Trend thumbnails** — 12/12 generated and committed to `public/trends/`;
  `check:assets` passes.

## ✅ Done earlier (2026-07-24 → 2026-09-06)

- **Video (Phase 4b) code complete (2026-09-06)** — five families (Veo 3.1, Gemini Omni
  Flash 1.1, Kling 3.0 Pro, Runway Gen-4.5, Seedance 2.5) via new adapters in
  `_shared/providers/` (`google-video.ts`, `google-omni.ts`, `runway.ts`, `fal.ts`
  extended); mode matrix t2v/i2v/ref2v/keyframes/extend/edit; Cloudflare R2 storage
  adapters (`_shared/storage/`); client-captured poster frames; waiting-UX components
  (`mode-picker`, `reference-drop`, `video-picker-dialog`, `pending-video-card`,
  `rendering-chip`); 3-concurrent-job + $40/day caps; cancel + refund. Migration
  `0016_video.sql` written but not yet applied; see the 🟡 rollout-pending item below
  for what's still needed before this is live.
- **AI Sharpen wired (2026-09-05)** — NAFNet deblur ONNX (MIT, ~88 MB) as Pro rail tool
  `aisharpen`; `engines/deblur-engine.ts` tiled like Upscale, WebGPU→wasm fallback,
  16 MP cap. Build + 197 tests green.
- **Docs refreshed (2026-09-05)** — `vansen.md` Status rewritten to 09-05 (07-11 tools
  expansion → 07-24 personas/analytics, open items), Billing §5 now shows the credit plan
  model (old $15/$30 Tier 1/2 table gone), `/admin/pricing` noted as moved to backoffice,
  §2 records polling-not-Realtime as built. `README.md` replaced Angular boilerplate.
- **Cruft removed (2026-09-05)** — nested `supabase/functions/supabase/` deleted, three
  `.DS_Store` files deleted; `.gitignore` now covers `.DS_Store` and `/supabase/.temp/`
  (root `.temp/` is legit CLI link state, kept).
- **Plans committed (2026-07-24)** — analytics + personas + trends landed as
  `Added style feature` / `Fix left panel`.
- **Auth + UI fixes (2026-08-14, 2026-09-05)** — `Fix auth`, `Fix buttons`, `Fix misc`;
  `api` redeployed as v41.
- **Mobile platform stamping** — `DioApiClient` sends `x-vansen-client: ios|android` on
  every request (`~/StudioProjects/Vansen-mobile/lib/core/api/client_tag.dart`).
- **Google AI key** — the 2026-08 Nano Banana `free_tier limit: 0` 429s are resolved;
  Nano Banana Pro generates fine (user-confirmed 2026-09-05).
- **Flutter error hooks** — `ErrorReporter` POSTs uncaught errors to `POST /errors`
  (mirrors web reporter: skips `ApiException`, 60 s dedupe, sends `appVersion`).

## ⏸️ Not started yet (deferred by design)

- **Denoise / Colorize** — no license-clean hosted ONNX; need offline export
  (NAFNet-SIDD .pth MIT, DDColor tiny Apache) + self-hosting.
