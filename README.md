# Vansen

AI image generation and editing broker (Higgsfield-style wrapper) by Vankode Technology.
Angular web client + Supabase backend; provider adapters for Google (Nano Banana),
OpenAI (GPT Image) and fal (FLUX, Seedream, upscaler, LoRA personas). Credit-denominated
subscriptions (Studio / Pro) billed through Stripe on web and Apple IAP on iOS.

Full product spec and current status: [`vansen.md`](vansen.md). Working rules for
contributors and Claude: [`CLAUDE.md`](CLAUDE.md). Open follow-ups:
[`docs/superpowers/punchlist.md`](docs/superpowers/punchlist.md).

## Repository layout

| Path | What lives there |
| --- | --- |
| `src/app/features/` | Angular 22 standalone components (workspace, studio editing, auth, billing, legal, onboarding). Every component is `.ts` + `.html` + `.css`. |
| `src/app/core/catalog/` | Shared masters: model families, style presets, trend presets. Source of truth for the edge copies. |
| `src/app/core/editing/` | Client-side Canvas2D editing engine (worker + fallback), pure pixel ops, lazy ONNX engines (MI-GAN heal, ISNet cut-out, Depth Anything bokeh, Swin2SR upscale, SlimSAM smart select). |
| `supabase/functions/api/` | Hono gateway Edge Function. The only data path — tables are RLS deny-all, RPCs service-role only. |
| `supabase/functions/stripe-webhook/`, `appstore-webhook/` | Sole ledger writers for Stripe top-ups and Apple IAP respectively. |
| `supabase/functions/_shared/` | Provider adapters, moderation, push (FCM), IAP verification, generated catalog copies. Bundled into `api` on deploy. |
| `supabase/migrations/` | Schema record `0001` … `0015`, applied via MCP. |
| `public/styles/` | Style preset thumbnails (`public/trends/` still to be generated). |
| `scripts/` | `sync-shared.mjs` (catalog → edge copy), `gen-style-thumbs.mjs`, `gen-trend-thumbs.mjs`. |
| `docs/superpowers/specs/`, `plans/` | Design specs and implementation plans, dated. |

Related repos: `vankode-backoffice` (admin console, reads Vansen through its own service
key) and `Vansen-mobile` (Flutter client).

## Prerequisites

- Node 22.23.1 via nvm (`nvm use 22.23.1`).
- Deno (for `_shared` tests) and the Supabase CLI (for deploys).
- Access to Supabase project `vansen` (`bnorhcxhvxydkgvcxjad`, ap-southeast-1).

Client config is `src/environments/environment.ts` (Supabase URL, publishable anon key,
`apiBaseUrl`). No secrets belong in this repo. Provider keys (`GOOGLE_AI_API_KEY`,
`OPENAI_API_KEY`, `FAL_API_KEY`), Stripe keys and the FCM service account live only in
Supabase Edge Function secrets.

## Develop

```bash
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use 22.23.1 >/dev/null && npx ng serve
```

App runs at `http://localhost:4200/`. Auth goes straight to the live Supabase project;
all data goes through the deployed `api` function.

## Build

```bash
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use 22.23.1 >/dev/null && npx ng build
```

## Test

Angular (Vitest through the Angular builder — run it this way, a bare `npx vitest run`
falsely fails every TestBed spec):

```bash
npm test -- --watch=false
```

Edge Function shared modules:

```bash
cd supabase/functions && deno test --allow-all _shared
```

A vitest drift guard fails if `supabase/functions/_shared/` copies of the catalog masters
are stale. After editing anything in `src/app/core/catalog/`, run:

```bash
npm run sync-shared
```

## Deploy

Redeploy `api` after any change under `supabase/functions/api/` or `_shared/` (the bundle
must include every `_shared/` file, including `providers/`):

```bash
supabase functions deploy api --project-ref bnorhcxhvxydkgvcxjad --no-verify-jwt
```

Check health at `GET <apiBaseUrl>/health` → `{"ok":true,"db":true}`. Schema changes are
applied through the Supabase MCP tooling and recorded as a new file in
`supabase/migrations/`.

## Ground rules

- Never commit, branch or push from automation. The owner commits personally on `main`.
- No nested `if` statements; guard clauses and early returns.
- Stylesheet classes over inline styles; no inline templates.
- Only ship ML engines whose code and weights are commercial-safe. Banned list in `CLAUDE.md`.
