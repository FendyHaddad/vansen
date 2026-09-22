# Staging environment — design

**Date:** 2026-09-22
**Status:** DESIGN APPROVED, not implemented. Plan:
`plans/2026-09-22-staging-environment.md`.
**Revised 2026-09-22 (evening)** after checking the design against the code:
§3.6 and three limits in §5 were added.
**Owner decision it answers:** review item 21 — "we may also need a staging
environment. an opensource supabase local db would be great, so it looks the
same as the production. reason why i cant have this in supabase cloud is
because ive used it for production and another project call algawth."

---

## 1. Why this exists

Today there is no environment between a developer's editor and the live
system. Two consequences, both currently true:

- `src/environments/environment.development.ts` points at
  `https://bnorhcxhvxydkgvcxjad.supabase.co`. **`ng serve` talks to
  production.** Any click-testing of the web app writes production rows and
  spends production credits.
- The only non-production database is the one `npm run db:test:start` brings
  up for the SQL gates. It is torn down after the gates run and holds no
  usable account, so nothing can be exercised through the UI.

Supabase is open source and self-hostable. The CLI already runs the same
container set the hosted project runs — Postgres 17, GoTrue, PostgREST,
Storage, Realtime, Kong, Studio — from `supabase/config.toml`. Staging is
therefore not new infrastructure. It is the stack that already exists, plus
the four things it is missing: provider keys, seeded data, a web app pointed
at it, and something to tick the job worker.

## 2. Scope

Decided with the owner on 2026-09-22.

**In scope.** Migrations apply clean; the five Edge Functions serve; the
Angular app runs end-to-end against a non-production database; generation
works with the owner's real provider keys where they are supplied.

The review's original item 21 asked for more — a Stripe webhook tunnel, an
R2 stand-in, six seeded account states. The owner scoped it down to
"schema + API + UI" on 2026-09-22; the rest is below as out of scope.

**Out of scope, deliberately.**

| Not covered | Why |
|---|---|
| Inbound Stripe / Apple webhooks | No public HTTPS on a laptop. Credits come from `stage:grant` instead. |
| Always-on shared URL | Staging is a local developer environment, not a hosted one. |
| A second Supabase Cloud project | The cloud org is taken by production and `algawth`. |
| Video families | Need R2 and `RUNWAY_API_KEY`; all five stay `enabled = false`, as in production (D7). |

## 3. Architecture

```
supabase start            Postgres 17 + GoTrue + Storage + Kong   :54321/:54322
  └─ migrations 0001→0030 applied by the CLI
supabase functions serve  api, job-worker, cleanup-worker,        :54321/functions/v1
                          stripe-webhook, appstore-webhook
  └─ reads supabase/.env.staging  (gitignored)
ng serve                  environment.development.ts → :54321      :4200
stage:worker              POSTs job-worker every 15s
```

Nothing new is deployed. Everything runs on the developer's machine and dies
with `npm run stage:stop`.

### 3.1 Provider keys — `supabase/.env.staging`

Gitignored. The owner pastes their keys in once. A committed
`supabase/.env.staging.example` documents the names and nothing else.

```
GOOGLE_AI_API_KEY=
OPENAI_API_KEY=
FAL_API_KEY=
JOB_WORKER_SECRET=staging-worker-secret
STRIPE_SECRET_KEY=sk_test_staging_unused
MEDIA_PUBLIC_ORIGIN=http://127.0.0.1:54321
```

The last three are not provider keys. `JOB_WORKER_SECRET` is any string:
`job-worker` refuses every request until one is set. `STRIPE_SECRET_KEY` is a
placeholder, never a real key: `api/index.ts` constructs a Stripe client at
module load and needs a non-empty string to boot. `MEDIA_PUBLIC_ORIGIN` is
explained in §3.6.

This file carries **no Stripe key and no service-role key for the hosted
project**. The local stack prints its own service-role key from
`supabase status -o env`; the scripts read it from there rather than storing
it.

The rule from `CLAUDE.md` — provider keys live only in Edge Function secrets,
never in the repo — is preserved: `.env.staging` is the local equivalent of
those secrets and is never committed.

### 3.2 Seed — `scripts/stage-seed.mjs`

Runs against `postgresql://postgres:postgres@127.0.0.1:54322/postgres`. It is
idempotent: running it twice leaves the same world.

1. **Users.** Three accounts created through GoTrue's admin API so they have
   real `auth.users` rows and can actually sign in:

   | Email | Password | Plan |
   |---|---|---|
   | `free@staging.vansen` | `staging-pass` | none |
   | `studio@staging.vansen` | `staging-pass` | studio |
   | `pro@staging.vansen` | `staging-pass` | pro |

2. **Money.** Credits are granted through the real
   `fn_apply_fulfillment('stripe', 'seed:<email>', …)`, not by inserting
   ledger rows. The seed therefore exercises the same path a purchase takes,
   and a second run is absorbed by the function's idempotency instead of
   double-granting.

3. **Model families.** The migrations already insert the image families with
   `enabled = true` and the five video families with `enabled = false`. The
   seed touches only the image side: it reads `.env.staging` and **disables the
   families whose key is absent**: no `FAL_API_KEY` disables `flux`, `seedream`,
   `upscaler`, the four `edit-*` tools and `persona`; no `GOOGLE_AI_API_KEY`
   disables the Nano Banana families; no `OPENAI_API_KEY` disables
   `gpt-image`. This is the owner's stated fallback — real keys where
   available, disabled where not — applied per family rather than globally.

4. **Grants.** Found during implementation (2026-09-22): a database rebuilt
   from the migrations alone leaves `service_role` — the role the api uses
   for every read and write — with only truncate/references/trigger on the
   public tables, so every route answers `not_found`. The hosted project was
   granted data access when it was created and never lost it. The seed runs
   an idempotent `grant select, insert, update, delete on all tables in
   schema public to service_role` (plus sequences and default privileges)
   first. DECIDED 2026-09-22: the same grants are also migration
   `0031_service_role_table_grants.sql`, so a from-scratch restore works
   without the seed; the seed keeps them for databases reset earlier.

5. **Moderation.** The gate calls OpenAI omni-moderation before every charge.
   Without `OPENAI_API_KEY` it raises `moderation_unavailable` and refuses
   everything, so the seed prints a warning naming that consequence rather
   than letting the owner discover it as a mysterious refusal.

### 3.3 Web app — `environment.development.ts`

Rewritten to the local stack:

```ts
export const environment = {
  supabaseUrl: 'http://127.0.0.1:54321',
  supabaseAnonKey: '<from `supabase status -o env`>',
  apiBaseUrl: 'http://127.0.0.1:54321/functions/v1/api',
  releaseCapabilities: { backgroundCompletion: false, completionNotifications: false },
};
```

`environment.ts` (production) is untouched. The local anon key is the CLI's
fixed development key — public by design, valid only against a stack on
localhost.

`supabase/config.toml` already allow-lists `http://localhost:4200/reset`,
`/confirm` and `/app`, so password-recovery and confirmation links work and
land in the local mailbox on port 54324.

### 3.4 Commands

Added to `package.json`:

| Command | What it does |
|---|---|
| `npm run stage` | Starts the stack if down, serves the functions, ticks the worker, runs `ng serve`. One terminal. |
| `npm run stage:seed` | Rebuilds the world described in §3.2. ~5 seconds. |
| `npm run stage:grant <email> <credits>` | Grants credits through `fn_apply_fulfillment`. Stands in for a purchase, since no webhook can reach a laptop. |
| `npm run stage:stop` | Stops the containers. Ctrl-C in the `npm run stage` terminal stops the functions and the worker. |

`npm run stage` refuses to start if `.env.staging` is missing, and names the
example file.

### 3.5 The job worker

Production runs `job-worker` on a schedule. Nothing calls it locally, so a
fal-queued generation would sit `pending` forever and the UI would look
broken. `stage:worker` POSTs the function every 15 seconds for as long as
staging is up. It is a loop in the `stage` script, not a cron job, so it
cannot outlive the session.

`cleanup-worker` and the purge cron are **not** ticked. Deletion and purge
behaviour is covered by the SQL gates; running them against a staging library
would only destroy the data the developer just seeded.

### 3.6 Browser-reachable media URLs — `MEDIA_PUBLIC_ORIGIN`

Found while checking the design against the code. Inside the local Edge
runtime the CLI sets `SUPABASE_URL` to `http://kong:8000`, a hostname only
other containers can resolve. Every signed storage URL the API hands the
browser — thumbnails, originals, upload previews, persona photos — would carry
that host and be dead on arrival. The CLI also refuses `SUPABASE_*` names in
an env file, so it cannot be overridden from `.env.staging`.

The fix is one small, env-gated helper in `api/app.ts`, `browserUrl(signed)`:
when `MEDIA_PUBLIC_ORIGIN` is set, the signed URL's origin is replaced with it
and the path and token are kept. Unset — production — the URL is returned
untouched, so live behaviour does not change. It is applied at the four
places a signed URL is meant for a browser, and **not** at the places a signed
URL is meant for a provider (reference images, persona zips), because no
origin makes a laptop reachable from fal's servers (see §5).

## 4. Coexistence with `npm run verify`

One set of containers, shared. `npm run verify` runs `supabase db reset`,
which empties the database and replays 0001→0030 — that reset is what makes
the gate mean anything, so staging does not get to prevent it.

Staging data is therefore **disposable by design**. After any reset,
`npm run stage:seed` restores the world in about five seconds. No second port
block, no second `config.toml`, nothing to keep in sync.

## 5. What this does not prove

Stated plainly so nothing is claimed for staging that it cannot support:

- **No purchase completes.** Stripe Checkout in staging reaches Stripe's real
  test mode, and the `checkout.session.completed` webhook has nowhere to go.
  The billing UI, pricing and plan gating are exercisable; the grant is not.
  Use `stage:grant`.
- **No Apple purchase or refund.** Same reason.
- **Text-to-image only.** Any operation that sends an *input* image to a
  provider — upscale, the four AI edit tools, reference images, persona
  training — hands the provider a signed URL into local storage, and fal's
  servers cannot fetch from a laptop. Those tools fail in staging with a
  provider error. Local Canvas2D/ONNX editing tools run in the browser and
  are unaffected.
- **The Subscription tab's Stripe panel shows an error.** `GET
  /billing/overview` and the checkout guards read straight from Stripe with
  the placeholder key. The routes already catch the failure; the tab renders
  its error state. Plan, status and credit balance come from our own tables
  and render normally.
- **Scheduled jobs mostly no-op.** The cron rows that drive the workers read
  their URL and secret from `vault.decrypted_secrets`, which is empty
  locally, so they fail harmlessly every five minutes. `reconcile_stale_jobs`
  and the daily purge run against the local tables; the seeded accounts have
  30-day periods and are not affected.
- **Not a load or uptime test.** One developer machine, one browser.
- **Not a production rehearsal.** The hosted project has different secrets,
  different provider quotas and a real Cloudflare Worker in front of the web
  bundle. The release runbook remains the authority for deploying.

## 6. Risks

| Risk | Mitigation |
|---|---|
| A key pasted into `.env.staging` gets committed | Path added to `.gitignore` in the same change; `verify` already fails a dirty tree at deploy time. |
| Real provider keys spend real money from staging | The seed prints the enabled families and a one-line cost reminder at the end of every run. |
| Staging drifts from production | Both apply the same migration files, and `bootstrap-manifest.json` already refuses a migration set that does not match the inventory. |
| A developer mistakes staging for production | `environment.development.ts` is only used by `ng serve`; `ng build` uses `environment.ts`. The staging app shows the local URL in the manifest response. |

## 7. Acceptance

Staging is done when, from a clean checkout on a machine with Docker, `psql`
and the pinned CLI:

1. `npm run stage:seed` completes and prints which families are enabled.
2. `npm run stage` opens the app at `localhost:4200`.
3. `studio@staging.vansen` signs in, and the library, settings and billing
   pages render with the seeded credit balance.
4. With `FAL_API_KEY` present, one text-to-image generation completes end to
   end: charged, dispatched, polled, stored, and its thumbnail actually
   renders in the library (proving `MEDIA_PUBLIC_ORIGIN`).
5. With no key present, the same click returns the kill-switch refusal rather
   than an error.
6. `npm run verify` still exits 0 afterwards, and `npm run stage:seed`
   restores the world.
