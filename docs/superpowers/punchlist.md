# Punchlist — as of 2026-09-05

Working tree is clean apart from this doc refresh (`README.md`, `vansen.md`, `.gitignore`,
this file). All automated gates are green: `ng build` clean, 197 vitest + 19 deno tests;
`api` v41 deployed 2026-08-14 and in sync with backend HEAD, health `{"ok":true,"db":true}`.

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

- **Abuse controls from spec, not built** — concurrent-session cap / account-sharing
  heuristics, dispatch rate limit, daily provider-spend alarm (`vansen.md` Security section).
- **i18n** — spec calls for en + ms; nothing started.
- **CI** — no pipeline; build/test/deno gates run by hand.

---

## ✅ Done since last update (2026-07-24 → 2026-09-05)

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

- **Video (Phase 4b)** — locked teaser. When it ships, use Cloudflare R2 for video
  storage, not Supabase Storage (egress cost).
- **Denoise / Colorize** — no license-clean hosted ONNX; need offline export
  (NAFNet-SIDD .pth MIT, DDColor tiny Apache) + self-hosting.
