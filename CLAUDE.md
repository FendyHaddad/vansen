# Vansen — Claude instructions

## Git
- **Never commit, branch, or push.** The user makes all commits personally.
- All work happens on the same single branch — never create branches.

## Components
- Angular components always use separate files: `.ts` + `.html` + `.css`. Never inline
  templates or styles.
- Prefer stylesheet classes over inline `style` attributes.

## Build
- Node via nvm: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use 22.23.1 >/dev/null && npx ng build`

## Backend (Foundation, live)
- Supabase project `vansen` — ref `bnorhcxhvxydkgvcxjad`, region ap-southeast-1, org Vankode.
- All data through Edge Function `api` (Hono gateway); tables RLS deny-all; RPCs
  service_role-only. Client uses supabase-js for AUTH ONLY.
- Schema record: `supabase/migrations/0001_foundation_schema.sql` (applied via MCP).
- Shared enums/catalog: Angular masters; `npm run sync-shared` regenerates
  `supabase/functions/_shared/`; vitest guards drift. Redeploy `api` after catalog changes.
- Stripe (TEST MODE): hosted checkout via `POST /billing/*` on `api`; `stripe-webhook`
  function is the only `topup` ledger writer (signature + dedupe + stripe_ref UNIQUE).
  Secrets live in Supabase Edge Function secrets: STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET, STRIPE_STUDIO_PRICE_ID. Never put Stripe keys in the repo.
- First purchase $15 = $10 credits + $5/mo Studio; top-up presets 10/20/50/100 (min $10).
- Purge cron `purge_lapsed` (NOT `purge_lapsed_libraries`) daily 03:00 UTC. D2 removed
  the 30-day grace: content is purged the day the paid period ends. Retention policy:
  `docs/superpowers/specs/2026-09-20-retention-policy.md`.
- Generation (Phase 3a, live): provider adapters in `supabase/functions/_shared/providers/`
  (google=Nano Banana inline, openai=GPT Image inline, fal=FLUX/Seedream/upscaler via
  queue + `GET /jobs` polling). Generations insert `pending`; `fn_fail_job` refunds once
  (`ledger_refund_once` index); stale-job sweep cron every 5 min. Outputs in private
  `media` bucket, 7-day signed URLs. Moderation gate (OpenAI omni-moderation) runs BEFORE
  charge and BEFORE any provider call; 2 strikes = suspension, evidence kept in
  `moderation_events` for appeals. Kill switch = `models.enabled`. Upscale = fal
  clarity-upscaler, family id `upscaler`. Provider keys ONLY in Edge Function secrets:
  GOOGLE_AI_API_KEY (needs paid tier — free tier has zero image quota), OPENAI_API_KEY
  (also powers moderation), FAL_API_KEY. Redeploying `api` must bundle every `_shared/`
  file including `providers/`.
- Studio editing (Phase 3b, live): workspace edit mode (grid ↔ canvas swap, old
  `/app/edit/:id` absorbed). Local tools = Canvas2D engine `src/app/core/editing/`
  (worker + fallback; heal = MI-GAN inpainting, MIT, via lazy onnxruntime-web —
  28 MB ONNX model from HuggingFace on first use, cached in Cache Storage
  `vansen-models`, ort wasm from jsDelivr, version pinned to the runtime (see `ortWasmBase()` — the 25.6 MB WebGPU build is over Cloudflare's 25 MB asset cap); PatchMatch
  in `ops/heal.ts` stays as offline fallback — angular.json needs
  externalDependencies crypto/fs/path). More local tools: Studio = rotate/flip/straighten
  (`ops/transform.ts`) + filters (`ops/filters.ts`); Pro-preview (unlocked while testing,
  lock pass pending user approval) = enhance/levels/clone/retouch/perspective (pure ops)
  plus ONNX engines in `core/editing/engines/` (shared `model-loader.ts`, same
  `vansen-models` cache): Cut Out = ISNet fp16 88MB (imgly, MIT), Bokeh = Depth Anything
  V2 small quantized 27MB (Apache — B/L variants are NC, never use), Upscale 2× = Swin2SR
  lightweight tiled 8MB (Apache), Smart Select = SlimSAM-77 quantized enc+dec 14MB
  (Apache; click→mask→MI-GAN remove or alpha cut-out). RMBG (bria) and the AGPL ISNet
  mirror are license-banned. `POST /edits/save` = moderated $0 "Studio Edit"
  version, Studio-gated (403 `studio_required`). AI edit tools `edit-remove|edit-fill|
  edit-expand|edit-bg` in `EDIT_TOOLS` (model-families.ts): FIXED retail prices
  ($0.10/$0.10/$0.10/$0.05, not the margin formula), op='edit' + familyId=tool id,
  fal FLUX-fill (mask as data URI) + BiRefNet, kill-switch rows in `models`.
  Expand = client pads canvas 25%/side + border mask.
  Video (Phase 4b, written but DISABLED — see D7): five families veo/omni (Google, no cancel), kling/seedance (fal), runway
  (direct) in `_shared/providers/`; modes t2v/i2v/ref2v/keyframes/extend/edit gated by
  `capabilities.modes`; Pro-only; caps = 3 pending videos + $40/day provider spend
  (`VIDEO_DAILY_CAP_USD`). Files stream to Cloudflare R2 (`_shared/storage/`, secrets R2_*),
  posters are client-captured JPEGs via `POST /generations/:id/thumb`. Cancel =
  `POST /jobs/:id/cancel` (fal queued-only, runway any). Stale sweep: video 30 min.
  Secrets: RUNWAY_API_KEY, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET.
  State as of 2026-09-22, from the live system: `0016_video.sql` IS applied, the R2
  bucket `vansen-media` exists and the four R2_* secrets are set. Still missing:
  bucket CORS, the `storage_config.r2_bucket` row, RUNWAY_API_KEY, and every live
  smoke. All five families are `enabled = false`. Claim no video capability
  anywhere until a family passes the per-family checklist in
  `docs/superpowers/plans/2026-09-20-release-runbook.md`.
- Studio expansion (2026-07-11): 17 filter presets (new: fade/noir/matte/tealorange/
  goldenhour/crossprocess/infrared/bleach/duotone/clarity; duotone takes colorA/colorB,
  clarity precomputes blurred luminance), Dehaze (dark-channel prior, `ops/dehaze.ts`) +
  Portrait Smooth (freq-separation, `ops/portrait-smooth.ts`) pure ops, Magic Erase
  (`erase` tool: tap → SlimSAM → dilate 3px → MI-GAN heal, no new model). Perf: all
  color/filter previews run on the ≤1100px proxy; slider input coalesced per frame via
  `core/editing/preview-scheduler.ts` (bokeh keeps 150ms timer). Phase-4 engine ledger:
  AI Sharpen = NAFNet deblur ONNX, MIT, 87.5MB, HF `opencv/deblurring_nafnet`
  (dynamic HxW, RGB 0..1) — WIRED 2026-09-05 as Pro tool `aisharpen` via
  `engines/deblur-engine.ts` (tile 256 + 32 overlap, pad ×16); Denoise (NAFNet-SIDD .pth MIT)
  and Colorize (DDColor tiny, Apache) have NO license-clean hosted ONNX — need offline
  export + self-hosting (see docs/superpowers/plans/2026-07-11-phase4-model-notes.md).
  GFPGAN / CodeFormer / MODNet weights / face-parsing CelebA weights = banned (NC).

## Release
- Run every gate: `npm run verify` (set `VANSEN_LOCAL_DB` or the SQL gates are
  scored as a failure, because a skipped check is not a passed check).
- Local stack: `npm run db:test:start` / `npm run db:test:stop`. Start refuses a
  Supabase CLI other than the pinned 2.114.0, or a migration whose hash is not in
  `supabase/tests/bootstrap-manifest.json`.
- Staging: `npm run stage` (same local stack + `functions serve` + `ng serve`),
  seeded by `npm run stage:seed`, keys in gitignored `supabase/.env.staging`.
  `ng serve` points at localhost, not production. Text-to-image only; no purchase
  completes; migration 0031 (and the seed, for older databases) grants service_role
  table access a from-scratch database otherwise lacks.
  `MEDIA_PUBLIC_ORIGIN` must never be set on the hosted project.
  Design: `docs/superpowers/specs/2026-09-22-staging-environment-design.md`.
- CI: `.github/workflows/ci.yml`, three jobs, every push.
- Emergency kill switch: `update public.models set enabled = false where id = '<family>';`
  New submissions are refused; work already in flight settles and refunds normally.
- What is proven: `docs/superpowers/plans/2026-09-20-release-evidence.md`.
  How to deploy: `docs/superpowers/plans/2026-09-20-release-runbook.md`.

## Project docs
- Product spec: `vansen.md`
- Design specs: `docs/superpowers/specs/`
