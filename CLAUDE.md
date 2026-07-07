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
- Balances start at $0 — no top-ups until Stripe (phase 2). No trial credits.

## Project docs
- Product spec: `vansen.md`
- Design specs: `docs/superpowers/specs/`
