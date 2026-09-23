# Release runbook

Written 2026-09-22. Every step changes production and is the user's decision.
Present one, wait for a yes, run it, verify it, then move on. Never batch them.

**Order, and why it is not negotiable:** migrations before functions, because a
function calling a missing RPC fails every request. Functions before crons,
because a cron driving a missing function logs an error every minute. Crons
before flags, because a family enabled with no worker behind it takes money and
produces nothing.

Project ref `bnorhcxhvxydkgvcxjad`. Web client `https://vansen.vankode.com`.

---

## 0. Before anything

```bash
cd /Users/user/IdeaProjects/vansen && VANSEN_LOCAL_DB="postgresql://postgres:postgres@127.0.0.1:54322/postgres" npm run verify
```

Every check PASS, none skipped. Today this exits 1 on the trend assets; that is
a real blocker for the web client, not a formality to wave through.

Record the exact revision being deployed. It becomes `GIT_REVISION` in step 2
and is what `/manifest` will report back.

---

## 1. Apply the migration — **DONE 2026-09-22**

Applied with `--skip-vault`; verified in release evidence §10. The rest of this
section is kept for the next migration.

Production was at `0024`. `0025_release_telemetry.sql` is the only unapplied
file: it adds `fn_schema_version()`, the `alerts` table, `fn_raise_alert`,
`fn_resolve_checked_alerts`, `fn_check_alerts` and the `check_alerts` cron.

```bash
cd /Users/user/IdeaProjects/vansen && supabase db push --linked
```

Verify:

```bash
cd /Users/user/IdeaProjects/vansen && supabase migration list --linked | tail -5
```

Expected: `0025` present on both sides.

**0032 persona references — the one exception to migrations-first.** Run
`./deploy.sh` (functions) first, then `supabase db push --linked` immediately
after. Migration-first breaks the currently deployed job-worker tick, which
calls the `fn_claim_training_jobs` that 0032 drops; functions-first only makes
the persona routes 503 until 0032 lands. Pre-check, and do not start unless it
returns 0 (an old fal persona job would be polled by the Google adapter
forever):

```sql
select count(*) from public.jobs j join public.generations g on g.id = j.generation_id where g.family_id = 'persona' and j.state <> 'done';
```

0032 ships the persona kill switch off. The gateway's modelGate has no owner
bypass, so the smoke can only run once the row is enabled. Enable it, run the
live persona smoke, and if it fails set it back off:

```sql
update public.models set enabled = true where id = 'persona';
```

Run the persona smoke. If it fails:

```sql
update public.models set enabled = false where id = 'persona';
```

**Rollback.** 0025 is additive — one table, four functions, one cron. Dropping
them is safe and loses only alert history. Every earlier migration in this
cycle (0017–0024) is already applied and additive, with one exception worth
writing down: `ledger_entries.user_id` became nullable with `on delete set
null` in P6. Rolling that back after an account deletion has run would orphan
rows that have no owner to restore. **It is forward-only.**

---

## 2. Set the secrets — **manifest secrets DONE 2026-09-22**

Set each in the Supabase dashboard (Edge Functions → Secrets) or via
`supabase secrets set`. **Never print a secret value and never write one into
this repository.**

| Secret | Needed by | Value |
|---|---|---|
| `GIT_REVISION` | `/manifest` | the short SHA from step 0 |
| `DEPLOYED_AT` | `/manifest` | ISO timestamp of this deploy |
| `WORKER_VERSION` | `/manifest` | the `api` version this deploy produces |
| `RUNWAY_API_KEY` | Runway video | only if Runway is being enabled; it is not required for a web-only image release |

Already set and verified present (names only, never values): `APP_ORIGIN`,
`FAL_API_KEY`, `GOOGLE_AI_API_KEY`, `OPENAI_API_KEY`, `STRIPE_*`,
`JOB_WORKER_SECRET`, `CLEANUP_WORKER_SECRET`, `APPLE_*`, `R2_ACCOUNT_ID`,
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`.

Vault entries `job_worker_url`, `job_worker_secret`, `cleanup_worker_url` and
`cleanup_worker_secret` must exist and match the Edge secrets.
`0024_worker_drive_guard.sql` makes a missing Vault entry a warning per tick
rather than a migration failure, so **absence here is silent** — check it:

```bash
cd /Users/user/IdeaProjects/vansen && psql "$VANSEN_PROD_DB" -At -c "select name from vault.decrypted_secrets order by name;"
```

Expected: all four names present. No values are printed.

**Alert delivery is DEFERRED** by owner decision (2026-09-22): alerts are rows
in `public.alerts` and nothing delivers them. There is no destination to
configure and no test delivery to verify. Someone must look:

```sql
select kind, severity, first_seen_at, detail from public.alerts where resolved_at is null;
```

Put that query somewhere a human sees it daily, or accept that a critical
alert can sit unread.

---

## 3. R2: CORS and the storage config row

The bucket `vansen-media` was created 2026-09-22. Two things are missing.

**CORS** — `GET` and `HEAD` from the production origin only. Not `*`: a
wildcard lets any site on the internet stream our video egress at our expense.

```json
[
  {
    "AllowedOrigins": ["https://vansen.vankode.com"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["Content-Length", "Content-Type"],
    "MaxAgeSeconds": 3600
  }
]
```

**The config row** — the gateway reads the bucket name from
`storage_config`. Without it, video writes have nowhere to go.

Verify afterwards: a signed URL opens from `https://vansen.vankode.com` and is
refused from an unrelated origin; an expired signature is refused; the bucket
is not publicly listable. CORS restricts browsers, not possession of a URL —
check the expiry separately.

---

## 4. Deploy the functions — **DONE 2026-09-22** (api v51, stripe-webhook v21, appstore-webhook v11)

```bash
cd /Users/user/IdeaProjects/vansen && supabase functions deploy api --no-verify-jwt --project-ref bnorhcxhvxydkgvcxjad
```

```bash
cd /Users/user/IdeaProjects/vansen && supabase functions deploy job-worker --no-verify-jwt --project-ref bnorhcxhvxydkgvcxjad && supabase functions deploy cleanup-worker --no-verify-jwt --project-ref bnorhcxhvxydkgvcxjad
```

```bash
cd /Users/user/IdeaProjects/vansen && supabase functions deploy stripe-webhook --no-verify-jwt --project-ref bnorhcxhvxydkgvcxjad && supabase functions deploy appstore-webhook --no-verify-jwt --project-ref bnorhcxhvxydkgvcxjad
```

`stripe-webhook` and `appstore-webhook` have **not been redeployed since P2
rewrote them**. The live ones are the old ones. Do not skip that third command.
All five functions run with JWT verification off (`deploy.sh` passes
`--no-verify-jwt`; production shows `verify_jwt=false`). `stripe-webhook`
authenticates Stripe by signature instead, and is the only writer of `topup`
ledger rows.

Verify the deploy actually landed:

```bash
curl -s https://bnorhcxhvxydkgvcxjad.supabase.co/functions/v1/api/manifest
```

Expected: the `gitRevision` from step 0 and `schemaVersion` `0025`. **A stale
revision means the deploy did not land — stop, do not continue to crons.**

---

## 5. Verify the crons

```bash
cd /Users/user/IdeaProjects/vansen && psql "$VANSEN_PROD_DB" -c "select jobname, schedule, active from cron.job order by jobname;"
```

Expected, all `active = t`. **This list, not P9 Task 7 Step 6's** — that list
names three jobs that do not exist, under names 0020 and 0021 renamed:

| Expected job | Schedule | What it does |
|---|---|---|
| `advance_account_deletions` | | drives deletion closures forward |
| `check_alerts` | `*/5 * * * *` | **new in 0025** |
| `drive_cleanup_worker` | | pings `cleanup-worker` with `x-worker-secret` |
| `drive_job_worker` | | pings `job-worker` with `x-worker-secret` |
| `expire_lapsed_packs` | | |
| `purge_app_errors` | | 30-day diagnostics retention (D2) |
| `purge_lapsed` | daily 03:00 UTC | lapse purge — **named `purge_lapsed`, not `purge_lapsed_libraries`** |
| `reap_deleted_content` | | |
| `reconcile_stale_jobs` | every 5 min | includes lease expiry via `fn_expire_leases()` — there is no separate `release_expired_leases` job |

Active is not running. Check that they actually ran:

```bash
cd /Users/user/IdeaProjects/vansen && psql "$VANSEN_PROD_DB" -c "select jobname, status, start_time from cron.job_run_details order by start_time desc limit 20;"
```

A missing job is a failed migration. Repair it with a new additive migration —
never by hand-editing an applied one, and never by explaining it away.

---

## 6. Backfills and reconciliation

The plan's command was wrong on three counts and is corrected here: the script
is `backfill-thumbnails.**ts**`, it runs on **Deno** (so it shares the gateway's
one pinned decoder rather than a second Node implementation that could disagree
with it), and it has no `--dry-run` — its flags are `--batch`, `--max`, `--rps`
and `--json`.

Find out how much work there is first, which needs no credentials:

```bash
cd /Users/user/IdeaProjects/vansen && supabase db query --linked "select count(*) filter (where thumb_path is null) as needs_thumb, count(*) as total from public.generations where status='done' and coalesce(media_path,'') <> '';"
```

Then, with the service-role key held only in the shell that runs it:

```bash
cd /Users/user/IdeaProjects/vansen && read -rs "?SUPABASE_SERVICE_ROLE_KEY: " K && export SUPABASE_SERVICE_ROLE_KEY="$K" SUPABASE_URL=https://bnorhcxhvxydkgvcxjad.supabase.co && deno run --allow-env --allow-net --node-modules-dir=none scripts/backfill-thumbnails.ts --max 50 && node scripts/storage-inventory.mjs && node scripts/billing-reconcile.mjs; unset SUPABASE_SERVICE_ROLE_KEY K
```

`--node-modules-dir=none` is not optional: the repository root has a
`package.json`, which puts Deno in manual mode and makes it hunt for npm
dependencies in `node_modules` instead of its own cache. Without it the script
dies on `@supabase/realtime-js` before it reads a single row.

`storage-inventory` only demands the `R2_*` variables when an object actually
lives on R2; while every row in `storage_objects` is `backend = 'supabase'` it
needs nothing more than the two above.

Expected: zero orphans, zero leaks, zero unfulfilled purchases. **Any non-zero
result stops the rollout.** These scripts report; they never delete.

The billing half can also be run without any credential, because it is one RPC:

```bash
cd /Users/user/IdeaProjects/vansen && supabase db query --linked "select count(*) from public.fn_paid_unfulfilled(now() - interval '7 days');"
```

---

## 7. Stage the family rollout

Export the current flags first and write down the before/after list of exact
model-table IDs. Display names are not row IDs.

```bash
cd /Users/user/IdeaProjects/vansen && psql "$VANSEN_PROD_DB" -c "select id, enabled from public.models order by id;"
```

Currently enabled: `edit-bg`, `edit-expand`, `edit-fill`, `edit-remove`,
`flux`, `gpt-image`, `nano-banana`, `persona`, `seedream`, `upscaler`.
Currently disabled: `veo`, `omni`, `kling`, `seedance`, `runway`.

**Do not disable already-live image or edit families as an incidental step.**
They are serving customers.

One family at a time, cheapest and most-exercised first. Before enabling each:
its capability-record row is filled in from a real smoke, not documentation,
and `deno test` passes for its adapter. After enabling:

- one paid generation end to end — charge, media, balance and ledger row all agree
- one deliberate failure — exactly one refund, and a truthful message
- for video, one cancel — and Veo and Omni must *say* they cannot cancel rather than pretend
- Staging: R2-signed video URLs are not passed through `browserUrl`; expect broken video posters in staging until that is wired.
- `node scripts/billing-reconcile.mjs` reports zero discrepancies
- `select * from public.alerts where resolved_at is null;` is empty

Order: `flux` → `nano-banana` → `gpt-image` (P3 rewrote this adapter; watch it)
→ `upscaler` and the four `edit-*` → `persona` → `kling`, `seedance` → `veo`,
`omni` → `runway`.

**`flux` has no agreed retail price.** The owner deferred that decision on
2026-09-22. Decide it before enabling `flux`, not after.

Record each family's result in the evidence document. Do not enable the next
until the current one has every tick.

---

## 7b. Staging (local)

The open-source Supabase stack from `supabase/config.toml`, on the developer's
machine. Design: `specs/2026-09-22-staging-environment-design.md`; plan:
`plans/2026-09-22-staging-environment.md`.

    cp supabase/.env.staging.example supabase/.env.staging   # once, paste keys
    npm run stage:seed                                        # build the world
    npm run stage                                             # functions + ng serve
    npm run stage:grant studio@staging.vansen 500             # credits, no webhook
    npm run stage:stop                                        # stop the containers

Accounts: `free@` / `studio@` / `pro@staging.vansen`, password `staging-pass`.

`npm run verify` runs `supabase db reset` against the same containers and
empties them. That is intended: staging data is disposable, and `stage:seed`
restores it in about five seconds. Migration `0031_service_role_table_grants.sql`
grants service_role data access to the public tables; the seed repeats the
same idempotent grants for a database reset before that migration existed.

What staging does **not** prove: no Stripe or Apple purchase completes (no
webhook can reach a laptop); only text-to-image works (providers cannot fetch
input images from a laptop); the Subscription tab's Stripe panel errors; nothing
runs on a schedule except the job-worker tick `npm run stage` owns. This section
never replaces the deployment procedure in §§1–7.

`MEDIA_PUBLIC_ORIGIN` exists for the local stack only. It must never be set as
a secret on the hosted project: it would rewrite every media URL production
hands out.

## 7c. Assistant connection (MCP)

Spec: `specs/2026-09-23-mcp-connection-design.md` (§9 is the rollout order).
The gateway serves `POST /api/mcp` and the public PRM at
`/api/mcp/.well-known/oauth-protected-resource`; both are dark until the
owner steps are done and the flag is on.

- **Owner steps (dashboard):** enable the OAuth 2.1 server and Dynamic Client
  Registration, authorization path `/oauth/consent`, `site_url` =
  `https://vansen.vankode.com`, asymmetric (ES256) JWT signing keys.
- **Migration:** `0035_mcp_client.sql` (client tag `mcp`, request bucket `mcp`
  at 10 per minute).
- **Flag:** Edge Function secret `MCP_ENABLED`; only the exact string `on`
  enables `/mcp`. Anything else answers 503 `mcp_disabled` (the PRM is still
  served). This is also the kill switch.
- **Read back after deploy:** the PRM answers 200 with
  `resource = https://bnorhcxhvxydkgvcxjad.supabase.co/functions/v1/api/mcp`,
  and a bare `POST /api/mcp` answers 401 with a `WWW-Authenticate` header that
  names it.
- `MCP_PUBLIC_SUPABASE_URL` exists for `supabase functions serve` only (where
  `SUPABASE_URL` is `http://kong:8000`). Never set it on the hosted project:
  the PRM would point clients somewhere else.

## 8. Rollback

**Rehearsed 2026-09-23 on the local stack (§7b)** — commands and output in
the evidence document, §10 "2026-09-23 — rollback rehearsal (local stack)".
Rehearse there again before any real rollback. A production rollback has never
been run; neither has `wrangler rollback`.

| Step | Expected | Local 2026-09-23 |
|---|---|---|
| Disable one family mid-flight | New submissions refused; queued jobs still settle and refund correctly | PASS |
| Disable all submissions | Existing work drains; no new charges | PASS |
| Redeploy the previous `api` | Queued jobs still settle; no column a queued job reads has been dropped | PASS for `73cd5cb`; **FAIL for `76bc2a0` and older** |
| Re-enable | No duplicate charge, no duplicate grant, no double refund | PASS |

**The rule:** disable new submissions first, let existing work settle, and never
drop a column while a queued job depends on it.

The switch is `models.enabled`, read on every request (no cache; a missing row
is off). The worker never reads it, which is why in-flight work still settles.
There is no global switch: "disable all" is `update public.models set enabled
= false;`. **Re-enable by explicit id list** from the §7 export — a blanket
`set enabled = true` also turns on the five video families.

### The rollback-target rule

**Functions roll back only to a revision whose code works on the schema that is
live now. Migrations are forward-only.** A migration is never reverted to suit
old code.

Against schema `0034`. `0034` only updates data (`models.min_plan = 'pro'` for
the four AI edit tools) and drops nothing, so every verdict that held against
`0033` still holds:

| Revision | Against `0034` |
|---|---|
| `4588a10` (live before the phase 3+4 deploy, api v71) | **Safe.** Knows schema `0033`. The only thing `0034` changes is `models.min_plan`, which this revision already reads: its `modelGate` refuses a Studio caller with 403 `pro_required` on the four AI edit tools and its catalog serves them as `editTools[].plan` `pro`, the intended policy. It lacks `flat.upscale.plan` and style/trend thumbs (catalog `.3`) |
| `723fddd`, `e2af5be`, `73cd5cb` | **Safe.** Function code identical (`git diff 73cd5cb 723fddd -- supabase/functions` is empty); a rollback changes only the stamp |
| `76bc2a0` and everything older | **Unsafe.** Its job-worker calls `fn_claim_training_jobs` (dropped by 0032): every tick returns 500 after settling image jobs, so the notification drain never runs. Its persona create answers 400 `create_failed` (the insert omits `consent_attested_at`, NOT NULL since 0032) and its persona generation reads `personas.lora_url` (dropped) |

So today there is no safe rollback target that behaves differently from what is
live. Before each deploy, write down the live revision: that is the rollback
target, and it stays safe only until the next migration drops something it
reads.

Checking a candidate `$REV`:

```bash
cd /Users/user/IdeaProjects/vansen && git diff --stat $REV HEAD -- supabase/functions | tail -1 && git ls-tree --name-only $REV supabase/migrations/ | tail -1
```

Empty diff: safe. Otherwise, grep `$REV`'s functions for every object dropped
by a migration newer than the one it last knew, then serve it on the local
stack (below). The job-worker tick must return 200.

### Rolling back each component

`./deploy.sh` cannot roll back: it deploys the working tree at HEAD and refuses
a dirty tree. Supabase has no function-rollback command either (`supabase
functions` offers list/delete/download/deploy/new). A rollback is a redeploy
from an archived tree. Extract it under `$HOME`, not `/tmp`: Docker on this Mac
mounts `/private/tmp` as an empty directory and the runtime fails with "failed
to determine entrypoint".

```bash
cd /Users/user/IdeaProjects/vansen && REV=73cd5cb && W="$HOME/vansen-rollback/$REV" && mkdir -p "$W" && git archive $REV supabase/functions supabase/config.toml | tar -x -C "$W"
```

Rehearse it locally first (§7b stack, `npm run db:test:start && npm run stage:seed`):

```bash
cd /Users/user/IdeaProjects/vansen && supabase functions serve --workdir "$W" --no-verify-jwt --env-file supabase/.env.staging
```

Then `curl -s http://127.0.0.1:54321/functions/v1/api/manifest` (its
`catalogVersion` is the archived code's) and one job-worker tick, which must
return 200.

Production — the user runs these, one at a time. All five functions go back
together: they share `_shared` (catalog, settlement), and deploy.sh ships and
attests them as one revision. Flags as `scripts/deploy-backend.mjs` uses them;
`supabase functions list` shows all five live with `verify_jwt=false`.

```bash
cd /Users/user/IdeaProjects/vansen && for f in api job-worker cleanup-worker stripe-webhook appstore-webhook; do supabase functions deploy $f --no-verify-jwt --project-ref bnorhcxhvxydkgvcxjad --workdir "$W" || break; done
```

**Restamp the manifest.** A function deploy does not touch secrets, so
`/manifest` keeps reporting the old `GIT_REVISION`. Rehearsed: `76bc2a0` code
with the 723fddd stamp reported `gitRevision 723fddd` next to `catalogVersion
2026-09-23.1`. Setting secrets bumps every function's version by one, as in
deploy.sh step 6:

```bash
cd /Users/user/IdeaProjects/vansen && supabase secrets set GIT_REVISION=$REV DEPLOYED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ) WORKER_VERSION=v<job-worker version from functions list, plus one> --project-ref bnorhcxhvxydkgvcxjad
```

Verify: `gitRevision` is `$REV` and `catalogVersion` matches
`git show $REV:src/app/core/catalog/model-families.ts`. A function's version
number is not a code identity: secrets bump it.

**Web (Cloudflare Worker `vansen`).**

```bash
cd /Users/user/IdeaProjects/vansen && npx wrangler deployments list
```

```bash
cd /Users/user/IdeaProjects/vansen && npx wrangler rollback <version-id> --message "rollback to <rev>"
```

Versions carry no message or tag, so match them to revisions by timestamp
against `DEPLOYED_AT` and §10 of the evidence: `a5b95faa` (2026-09-23 00:09Z) =
`723fddd`, `029ca6d3` (2026-09-22 23:14Z) = `73cd5cb`, `b55be9fd` (18:21Z) =
`c16b7fd`. `src/` is unchanged from `73cd5cb` to `723fddd`. When the catalog
differs, **roll the web back first, then the functions**: this is deploy.sh's
order reversed. A stale browser against a newer server shows a stale price; a
newer browser against an older server makes broken requests.

**From the server-driven catalog revision on (`/profile` returns
`subscription.entitled`), roll the web back before or together with the
functions.** A functions-only rollback to an older revision removes `entitled`
from `/profile`, and the current web gate then reads every paid user as not
entitled.

**Migrations.** Forward-only. A bad migration is fixed by a new migration
(`00NN_*.sql`, re-record `supabase/tests/bootstrap-manifest.json`, `supabase db
push --linked`). Recent destructive migrations, whose data cannot be restored
by recreating the objects:

| Migration | Destroys |
|---|---|
| `0030` | `fn_cycle_reset`, `fn_grant_pack` |
| `0032` | every persona (deleted through `fn_delete_persona`), `training_jobs`, eight training/persona functions, nine `personas` columns, the `reconcile_stale_trainings` cron, four `dispatch_limits` rows |
| `0033` | `public.admins` (0 rows), `profiles.monthly_budget` (all null) |

### The three-in-the-morning command

```sql
update public.models set enabled = false where id = '<family>';
```

That is the kill switch. It refuses new submissions for that family and lets
everything already in flight settle and refund normally.

---

## 9. Confirm D7 from the running system

```bash
curl -s https://bnorhcxhvxydkgvcxjad.supabase.co/functions/v1/api/manifest | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const m=JSON.parse(s);console.log(Object.entries(m.capabilities).map(([k,v])=>`${v?'ON ':'off'} ${k}`).join('\n'))})"
```

Record the exact output, with the deployed revision, the schema version, worker
and cron execution, secret presence by name, R2 configuration, and each enabled
family's smoke evidence. **A capability boolean does not establish that a
migration, a storage backend or a provider works.** Record anything unknown as
unknown and leave that capability off.
