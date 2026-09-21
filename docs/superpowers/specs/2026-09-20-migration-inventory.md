# Migration inventory — repository versus deployed history

**Observed:** 2026-09-22
**Target:** Supabase project `Vansen`, ref `bnorhcxhvxydkgvcxjad`, ap-southeast-1
**Method:** `supabase migration list --linked`, `supabase db push --linked --dry-run`
and `supabase db diff --linked --schema public`. All three are read-only; no
write credential was used to produce this record.

There is **no staging environment**. `Vansen` is the only hosted project (the
account's other project, `Algawth`, is a different product and is not linked).
Every row below that says "production" means the single live database.

---

## 1. The ledger

All 25 files are recorded as applied. `db push --dry-run` reports
`{"upToDate":true,"migrations":[]}`, which is the authoritative statement that
nothing in the repository is waiting to be applied.

| Repository file | sha256 (12) | Deployed version | State |
|---|---|---|---|
| `0001_foundation_schema.sql` | `2d73451603b6` | 0001 | confirmed applied |
| `0002_input_hardening.sql` | `615ba0fe3b05` | 0002 | confirmed applied |
| `0003_billing.sql` | `5e29f121bd7c` | 0003 | confirmed applied |
| `0004_generation.sql` | `6f0f9cf91568` | 0004 | confirmed applied |
| `0005_studio_editing.sql` | `a0bef6d149ef` | 0005 | confirmed applied |
| `0006_observability.sql` | `14fc1a11fbfb` | 0006 | confirmed applied |
| `0007_owner_tier.sql` | `70b509d020be` | 0007 | confirmed applied |
| `0008_credit_plans.sql` | `2b8438f32d62` | 0008 | confirmed applied |
| `00091_age_gate.sql` | `9aef16ed22f4` | 00091 | confirmed applied |
| `0009_pending_plan_change.sql` | `815bf0b4b386` | 0009 | confirmed applied |
| `0010_cancel_reason.sql` | `0eb38a15f1a4` | 0010 | confirmed applied |
| `0011_devices.sql` | `b1a895ab5cbc` | 0011 | confirmed applied |
| `0012_iap.sql` | `166d67883c0c` | 0012 | confirmed applied |
| `0013_personas.sql` | `1624494b6d3b` | 0013 | confirmed applied |
| `0014_client_tracking.sql` | `35bb4346ec62` | 0014 | confirmed applied |
| `0015_backoffice_feature_usage.sql` | `21fe347b3721` | 0015 | confirmed applied |
| `0016_video.sql` | `e334b99446cc` | 0016 | confirmed applied (2026-09-21) |
| `0017_upload_registry.sql` | `e6b1495fc93f` | 0017 | confirmed applied |
| `0018_billing_fulfillment.sql` | `7fce316fa687` | 0018 | confirmed applied (2026-09-21) |
| `0019_job_settlement.sql` | `7b6f639c523c` | 0019 | confirmed applied (2026-09-21) |
| `0020_durable_dispatch.sql` | `d663bb6d54b1` | 0020 | confirmed applied (2026-09-21) |
| `0021_durable_deletion.sql` | `7163d945e964` | 0021 | confirmed applied (2026-09-21) |
| `0022_thumbnails.sql` | `47a0bdb16345` | 0022 | confirmed applied (2026-09-21) |
| `0023_request_snapshots.sql` | `d562b0ce2325` | 0023 | confirmed applied (2026-09-21) |
| `0024_worker_drive_guard.sql` | `31af71f71e5c` | 0024 | confirmed applied (2026-09-22) |

### The `0008` duplicate is gone, and why renaming it was safe

The plan and the earlier blockers record two files sharing the `0008_` prefix.
That is no longer true. `0008_age_gate.sql` was renamed `00091_age_gate.sql`
on 2026-09-22, **before it had ever been applied anywhere**: the remote ledger
at that time had only three timestamped rows and no `0008` entry for the age
gate, so no applied history was rewritten. Git dates established that
`0008_credit_plans.sql` was authored first and therefore keeps `0008`.

This is the single exception to "never rename an applied migration", and it is
an exception only because the file was not applied. `scripts/migration-inventory.mjs`
now carries an empty `ACCEPTED_DUPLICATES` set for that reason.

**A near miss worth recording:** `0008_credit_plans.sql` opens with
unconditional `delete from public.ledger_entries;` and
`delete from public.webhook_events;`. Before the rename, `db push --include-all`
wanted to re-apply it. Renaming the *other* file is what kept the CLI from
running those two statements against the live ledger.

### The `0009` display artifact

`supabase migration list --linked` prints two rows for version `0009` — one
with an empty `local`, one with an empty `remote`. This is a pairing artifact,
not a missing migration: the CLI sorts the two lists differently, and
lexicographically `0008 < 00091 < 0009`, so `00091` and `0009` cross over
between the local and remote orderings.

Evidence that both are applied: `db push --dry-run` reports nothing pending. If
`0009_pending_plan_change.sql` were unapplied, push would name it.

---

## 2. Schema drift: production has objects no migration creates

`supabase db diff --linked --schema public` compares the live database against
a shadow database built by replaying every migration from empty. It is not
empty. Two objects exist in production and in no migration:

| Object | In migrations | In code | In local stack | Assessment |
|---|---|---|---|---|
| `public.admins` (+ PK, FK to `auth.users`, RLS enabled) | no | no | no | orphaned manual drift |
| `public.profiles.monthly_budget numeric(12,2)` | no | no | no | orphaned manual drift |

Neither is referenced anywhere in `supabase/functions/` or `src/`. Both were
almost certainly created by hand in the dashboard during early development and
forgotten. They are harmless where they are — an unused table with RLS on, and
a nullable column nothing writes — but they mean **a database rebuilt from this
repository is not byte-identical to production**, which is exactly the
condition Task 2 Step 4 exists to detect.

**Proposed action: none yet.** Dropping them is destructive and is the owner's
call; codifying them in a migration would enshrine something nothing uses.
Recorded here so the difference is known rather than discovered during a
restore. See the open decision at the bottom.

### The grant noise in that diff is not drift

The same diff lists hundreds of `grant ... to anon/authenticated/service_role`
statements. Those are the default privileges the hosted `public` schema
carries and the CLI's bare shadow database does not. They are inert here, and
that was verified rather than assumed:

```
public tables without RLS ............... none
policies reachable by anon/authenticated  none
```

Every table in `public` has row-level security enabled and no policy admits
`anon`, `authenticated` or `public`. A grant without a policy grants nothing,
so the deny-all architecture holds.

---

## 3. Clean bootstrap versus upgrade

| Path | Status | Evidence |
|---|---|---|
| Empty database → all 26 migrations | **PASS** | `supabase db reset` applies 0001→**0025** with no error on 2026-09-22; all 11 local SQL gates pass against the result |
| Upgraded production | **PASS for the ledger, drift noted** | `db push --dry-run` up to date; `db diff` shows only the two orphaned objects in section 2 |
| Production-shaped synthetic snapshot → 0017–0024 | **BLOCKED** | No staging environment and no synthetic snapshot exists. The plan forbids using real customer data, and there is nowhere else to restore one |

The third row cannot be closed without a staging project. Per the owner's
decision on 2026-09-22, P9 proceeds with it recorded as BLOCKED rather than
inferred.

---

## 4. Deployment inventory (same observation date)

| Item | Observed |
|---|---|
| Edge functions | `api` v44, `job-worker` v3, `cleanup-worker` v2 — all deployed `--no-verify-jwt` |
| Functions in repo not deployed this cycle | `stripe-webhook`, `appstore-webhook` — **redeploy pending** (P2 rewrote both) |
| Cron jobs | `advance_account_deletions`, `drive_cleanup_worker`, `drive_job_worker`, `expire_lapsed_packs`, `purge_app_errors`, `purge_lapsed`, `reap_deleted_content`, `reconcile_stale_jobs`, `reconcile_stale_trainings` |
| Enabled model families | `edit-bg`, `edit-expand`, `edit-fill`, `edit-remove`, `flux`, `gpt-image`, `nano-banana`, `persona`, `seedream`, `upscaler` |
| Disabled families | all five video families (`veo`, `omni`, `kling`, `seedance`, `runway`) |
| Secrets present (names only) | `APPLE_BUNDLE_ID`, `APPLE_ENV`, `APP_ORIGIN`, `CLEANUP_WORKER_SECRET`, `FAL_API_KEY`, `GOOGLE_AI_API_KEY`, `JOB_WORKER_SECRET`, `OPENAI_API_KEY`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `STRIPE_*`, `SUPABASE_*` |
| Secrets absent | `RUNWAY_API_KEY`, `GIT_REVISION`, `DEPLOYED_AT`, `WORKER_VERSION` |
| R2 | bucket `vansen-media` created 2026-09-22; CORS policy and `storage_config.r2_bucket` row pending |
| Web client | `https://vansen.vankode.com`, Cloudflare Workers static assets |

No secret value was read or recorded. Presence was established from
`supabase secrets list`, which returns digests rather than values.

---

## 5. The cron names the plan expects are stale

P9 Task 7 Step 6 lists `purge_lapsed_libraries`, `release_expired_leases` and
`reconcile_stale_persona_trainings`. None of those exist. The migrations that
created them renamed them:

| P9 expects | Actually named | Renamed by |
|---|---|---|
| `purge_lapsed_libraries` | `purge_lapsed` | `0021` |
| `reconcile_stale_persona_trainings` | `reconcile_stale_trainings` | `0020` |
| `release_expired_leases` | *(no such job)* | lease expiry runs inside `reconcile_stale_jobs` via `fn_expire_leases()` |
| `fail_stale_jobs` | `reconcile_stale_jobs` | `0020` |

Four jobs exist that P9 does not list at all: `advance_account_deletions`,
`expire_lapsed_packs`, `purge_app_errors`, `reap_deleted_content`. The runbook
uses this table, not the plan's.

---

## 6. Open decisions

| Decision | Owner | Blocking |
|---|---|---|
| Drop `public.admins` and `profiles.monthly_budget`, or codify them in a migration, or leave the drift recorded | owner | no — they are unused and inert |
| Create a staging project, or accept Gate A and the restore rehearsal as permanently BLOCKED for this release | owner | yes, for Gate A |
| FLUX price: per-megapixel (P3) or the flat tiers | owner | yes, before `flux` is re-qualified |
