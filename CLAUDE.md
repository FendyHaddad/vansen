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
  (worker + fallback; heal = lazy OpenCV.js — angular.json needs
  externalDependencies crypto/fs/path). `POST /edits/save` = moderated $0 "Studio Edit"
  version, Studio-gated (403 `studio_required`). AI edit tools `edit-remove|edit-fill|
  edit-expand|edit-bg` in `EDIT_TOOLS` (model-families.ts): FIXED retail prices
  ($0.10/$0.10/$0.10/$0.05, not the margin formula), op='edit' + familyId=tool id,
  fal FLUX-fill (mask as data URI) + BiRefNet, kill-switch rows in `models`.
  Expand = client pads canvas 25%/side + border mask. Video = Phase 4b, locked teaser.

## Project docs
- Product spec: `vansen.md`
- Design specs: `docs/superpowers/specs/`
