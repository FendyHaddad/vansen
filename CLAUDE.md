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
- Purge cron `purge_lapsed_libraries` daily 03:00 UTC (30-day grace after lapse).
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
  `vansen-models`, ort wasm copied to `assets/ort` by angular.json; PatchMatch
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
  Expand = client pads canvas 25%/side + border mask. Video = Phase 4b, locked teaser.
- Studio expansion (2026-07-11): 17 filter presets (new: fade/noir/matte/tealorange/
  goldenhour/crossprocess/infrared/bleach/duotone/clarity; duotone takes colorA/colorB,
  clarity precomputes blurred luminance), Dehaze (dark-channel prior, `ops/dehaze.ts`) +
  Portrait Smooth (freq-separation, `ops/portrait-smooth.ts`) pure ops, Magic Erase
  (`erase` tool: tap → SlimSAM → dilate 3px → MI-GAN heal, no new model). Perf: all
  color/filter previews run on the ≤1100px proxy; slider input coalesced per frame via
  `core/editing/preview-scheduler.ts` (bokeh keeps 150ms timer). Phase-4 engine ledger:
  AI Sharpen = NAFNet deblur ONNX, MIT, 87.5MB, HF `opencv/deblurring_nafnet`
  (dynamic HxW, RGB 0..1) — verified but NOT wired yet; Denoise (NAFNet-SIDD .pth MIT)
  and Colorize (DDColor tiny, Apache) have NO license-clean hosted ONNX — need offline
  export + self-hosting (see docs/superpowers/plans/2026-07-11-phase4-model-notes.md).
  GFPGAN / CodeFormer / MODNet weights / face-parsing CelebA weights = banned (NC).

## Project docs
- Product spec: `vansen.md`
- Design specs: `docs/superpowers/specs/`
