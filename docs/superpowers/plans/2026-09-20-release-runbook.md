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

**Rollback.** 0025 is additive — one table, four functions, one cron. Dropping
them is safe and loses only alert history. Every earlier migration in this
cycle (0017–0024) is already applied and additive, with one exception worth
writing down: `ledger_entries.user_id` became nullable with `on delete set
null` in P6. Rolling that back after an account deletion has run would orphan
rows that have no owner to restore. **It is forward-only.**

---

## 2. Set the secrets

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

## 4. Deploy the functions

```bash
cd /Users/user/IdeaProjects/vansen && supabase functions deploy api --no-verify-jwt --project-ref bnorhcxhvxydkgvcxjad
```

```bash
cd /Users/user/IdeaProjects/vansen && supabase functions deploy job-worker --no-verify-jwt --project-ref bnorhcxhvxydkgvcxjad && supabase functions deploy cleanup-worker --no-verify-jwt --project-ref bnorhcxhvxydkgvcxjad
```

```bash
cd /Users/user/IdeaProjects/vansen && supabase functions deploy stripe-webhook --project-ref bnorhcxhvxydkgvcxjad && supabase functions deploy appstore-webhook --no-verify-jwt --project-ref bnorhcxhvxydkgvcxjad
```

`stripe-webhook` and `appstore-webhook` have **not been redeployed since P2
rewrote them**. The live ones are the old ones. Do not skip that third command.
`stripe-webhook` keeps JWT verification on — Stripe authenticates by signature,
and the function is the only writer of `topup` ledger rows.

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
| `reconcile_stale_trainings` | | **not** `reconcile_stale_persona_trainings` |

Active is not running. Check that they actually ran:

```bash
cd /Users/user/IdeaProjects/vansen && psql "$VANSEN_PROD_DB" -c "select jobname, status, start_time from cron.job_run_details order by start_time desc limit 20;"
```

A missing job is a failed migration. Repair it with a new additive migration —
never by hand-editing an applied one, and never by explaining it away.

---

## 6. Backfills and reconciliation

```bash
cd /Users/user/IdeaProjects/vansen && node scripts/backfill-thumbnails.mjs --limit 100 --dry-run
```

Read the output before running for real, then run in batches.

```bash
cd /Users/user/IdeaProjects/vansen && node scripts/storage-inventory.mjs && node scripts/billing-reconcile.mjs
```

Expected: zero orphans, zero leaks, zero unfulfilled purchases. **Any non-zero
result stops the rollout.** These scripts report; they never delete.

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

## 8. Rollback

Rehearse locally first. There is no staging to rehearse on — that is recorded
as BLOCKED in the evidence document, and it means the first real rehearsal of
these mechanics is on production.

| Step | Expected |
|---|---|
| Disable one family mid-flight | New submissions refused; queued jobs still settle and refund correctly |
| Disable all submissions | Existing work drains; no new charges |
| Redeploy the previous `api` | Queued jobs still settle; no column a queued job reads has been dropped |
| Re-enable | No duplicate charge, no duplicate grant, no double refund |

**The rule:** disable new submissions first, let existing work settle, and never
drop a column while a queued job depends on it.

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
