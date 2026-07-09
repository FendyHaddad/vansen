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

## Project docs
- Product spec: `vansen.md`
- Design specs: `docs/superpowers/specs/`
