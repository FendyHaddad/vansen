# Punchlist — as of 2026-09-06

Working tree has Video (Phase 4b) code plus this doc refresh (`README.md`, `vansen.md`,
`CLAUDE.md`, this file) uncommitted. All automated gates are green: `ng build` clean,
239 vitest + 40 deno tests; `api` v41 deployed 2026-08-14; Phase 4b gateway changes (video branch, cancel, thumb, R2) are NOT yet deployed
for everything except Video, whose deploy is pending redeploy (see 🟡 below), health
`{"ok":true,"db":true}`.

---

## 🔴 Needs your attention (paid or account-level — yours to run)

### 1. Trend thumbnails not generated (~$0.50 OpenAI)
Trend tiles bind to `/trends/<id>.webp`; `public/trends/` does not exist, so tiles render
alt text. Run:
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

- **Video (Phase 4b) rollout pending (2026-09-06)** — code is complete and gates are
  green, but nothing is live yet. User actions, in order: apply migration
  `supabase/migrations/0016_video.sql` (MCP `apply_migration`); set secrets
  `RUNWAY_API_KEY`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
  `R2_BUCKET`; create Cloudflare R2 bucket `vansen-media` + CORS (see
  `.superpowers/sdd/task-24-brief.md` Step 1 for the CORS JSON); redeploy
  `supabase functions deploy api --no-verify-jwt` (api version currently pending
  redeploy — do not assume a version number until this runs); enable each of the five
  `models` rows (`veo`, `omni`, `kling`, `runway`, `seedance`) one at a time via MCP
  `execute_sql` and smoke it live with a Pro account (cheapest settings per family,
  cancel + refund check, R2 object check) per Step 3 of the task-24 brief. Also carries
  two open product decisions: whether to bring back a "From library" picker for video
  reference slots (needs gateway `referenceIds` support — see
  `src/app/features/workspace/left-panel/reference-drop/reference-drop.ts`), and
  whether to keep the `provider_blocked` client copy ("Provider declined this prompt.
  Credits refunded.") or change the wording. Two more open follow-ups: whether poster
  JPEGs (client-captured, currently never re-submitted to moderation) need a moderation
  pass of their own; and `left-panel.ts` `hideAspect` currently hides the aspect-ratio
  chip for every non-t2v video mode (spec only called for hiding it on Kling i2v), so
  ref2v/keyframes users on families that do support a chosen ratio (veo, seedance) can't
  set one today — decide whether to narrow `hideAspect` or keep the broader hide.
- **Abuse controls from spec, not built** — concurrent-session cap / account-sharing
  heuristics, dispatch rate limit, daily provider-spend alarm (`vansen.md` Security section).
- **i18n** — spec calls for en + ms; nothing started.
- **CI** — no pipeline; build/test/deno gates run by hand.

---

## ✅ Done since last update (2026-07-24 → 2026-09-06)

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
