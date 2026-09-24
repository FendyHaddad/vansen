# Release evidence — what is actually proven

**Candidate revision:** `f7ca182` plus uncommitted P9 work (23 changed/new paths).
No release may cite this document until that work is committed and the SHA here
is replaced with the commit it produced.

**Observation date:** 2026-09-22. **Environment:** local (`supabase start`,
CLI 2.114.0) and the live `vansen` project `bnorhcxhvxydkgvcxjad`.

This document is what "release ready" means from now on. A green `npm run
verify` is one row in it. The rows that need a staging deployment, a browser, a
device or money are not closed by any amount of passing CI, and they are marked
so.

**The headline, stated plainly:** every automated gate passes. **Gate A cannot
be closed at all**, because there is no staging environment to close it against —
the owner's decision on 2026-09-22 was to record that as BLOCKED and ship
web-only rather than build a staging project first. Every production-only row
below is therefore pending Task 7, which is the user's to run.

---

## 1. Automated gates — `npm run verify`

Run 2026-09-22 against a database reset from empty (`supabase db reset`,
0001→0025) with `VANSEN_LOCAL_DB` set.

| Check | Status | Note |
|---|---|---|
| migration inventory | PASS | 26 files, 0 duplicate prefix groups |
| script unit tests | PASS | 72 tests |
| shared catalog drift | PASS | |
| JSON and Dart catalog drift | PASS | catalog `2026-09-21.1` |
| trend assets | PASS | 12/12 generated 2026-09-22, reviewed by eye |
| deno type check | PASS | six entry points |
| deno tests | PASS | 530 tests |
| web unit tests | PASS | 565 tests |
| web production build | PASS | |
| sql integration | PASS | 11 gate files, see section 2 |

`npm run verify` exits **0**. A skipped check is scored as a failure by design:
`scripts/verify-all.mjs` exits 1 when `sql integration` is skipped for want of
`VANSEN_LOCAL_DB`, so a green run here means all ten actually ran.

**CI:** `.github/workflows/ci.yml` runs the same checks in three jobs (web,
edge, database) on every push and pull request. No run link yet — it lands with
the first push, which is the user's action.

## 2. SQL and concurrency gates

Against a clean 0001→0025 bootstrap, 2026-09-22, all 11 PASS:

`alerts.sql` (11 cases, new in P9) · `billing_transactions.sql` ·
`caps_concurrency.sh` · `deletion.sql` · `dispatch.sql` · `job_settlement.sql` ·
`notification_outbox.sql` · `request_snapshots.sql` · `settlement_concurrency.sh` ·
`upload_ownership.sql` · (plus the preflight that proves `auth.users`,
`storage.objects`, `cron.job` and `pg_net` are present, so a suite cannot report
PASS against a baseline that lacks what it tests).

**Two of these had never run.** `dispatch.sql` and `caps_concurrency.sh` were
written during P5, before `0023` made the request snapshot mandatory, and the
local stack had been unable to start ever since. Both failed on first execution
(`snapshot_required`, and an all-zeros concurrency result). Both are fixed. The
live API was never affected — `app.ts` always passed a real snapshot — but for
roughly two plans these two files were decoration.

## 3. Gate A — staging regressions

**Status: BLOCKED, by owner decision on 2026-09-22.**

There is no staging project. The organisation holds `Vansen` (production,
linked) and `Algawth`, a different product. The plan forbids restoring real
customer data into a test environment, and no synthetic production-shaped
snapshot exists.

| Gate A item | Status | Why |
|---|---|---|
| Route and real-transaction regressions R01/R02/R04–R11/R28 on staging | BLOCKED | no staging |
| Authenticated direct table reads denied / service-only RPC denial | **PASS, locally** | `upload_ownership.sql` proves anon and authenticated are denied; RLS coverage re-verified during Task 2 — every table has RLS on, no anon-reachable policy |
| Offline completion, duplicate delivery, moderation unavailable, foreign refs, cancel-vs-success, retryable errors, deletion retries, lapse retention | **PASS, locally** | the 11 SQL gates plus 530 Deno tests; these are the same scenarios, against the real schema, without a deployment |
| Charge/refund/provider-expense reconciliation on staging | BLOCKED | no staging |
| Recorded staging revision / schema / functions / workers / cron runs | BLOCKED | no staging |

What this costs, stated honestly: nothing proves the **deployment mechanics**
before they are performed on production. The schema, the SQL and the gateway
logic are proven; the act of deploying them is not rehearsed anywhere.

## 4. Gate B — browser, device and role evidence

**Status: PENDING.** Requires a signed-in browser, real accounts in six states
(free, Studio, Pro, owner, suspended, lapsed) and a lower-memory device. None
of it is closed by this session.

| Row | Status |
|---|---|
| Fresh checkout, lockfile install, pinned toolchain, all checks + build | **PASS** — `.nvmrc` 22.23.1, `engines` pinned, `npm ci` path exercised in CI |
| Role entitlements across six account states | PENDING |
| Local editing tools on Chrome, Safari and a low-memory device | PENDING — P7 Tasks 5–6 results exist for Chrome only |
| Main workflows (generate, edit, import, export, delete; failure, cancel, refund, retry) | PENDING |
| Auth and isolation (signup → recovery → expiry → A→B change → logout everywhere) | PENDING |
| Commercial truth (D1 grants, cost units, post-checkout return state) | PENDING |
| Accessibility, assets, language | PENDING — assets now PASS; accessibility and language are untouched |
| Persona and paid edit smokes | PENDING — costs money, needs explicit spend approval |

## 5. Gate C — mobile

**Explicitly outside the scope of this release.** A web-only rollout excludes
mobile readiness; MT-01…MT-09 live in the mobile companion and none are linked
here. No sales surface may claim mobile availability.

**D6 stays unresolved.** Completion notifications require P4's outbox, P5's
offline lifecycle *and* mobile MT-04's actual client receipt. The third has not
happened, so "We'll notify you" stays hidden. The permitted wording remains
"You can leave this page and return to check the result."

## 6. Gate D — production readiness

| Row | Status | Detail |
|---|---|---|
| Provider contract smokes per enabled family | PENDING | needs budgeted spend approval |
| Billing configuration (Stripe live products/prices/coupons/webhooks) | PENDING | **Stripe is in TEST MODE.** Live-mode configuration has not been created |
| Deployment inventory | **RECORDED** | `docs/superpowers/specs/2026-09-20-migration-inventory.md` section 4 |
| Policy and retention review (D2) | **DECIDED**, owner review PENDING | `docs/superpowers/specs/2026-09-20-retention-policy.md` |
| Alerts exist and fire | **PASS** | `0025_release_telemetry.sql`, 11 assertions in `supabase/tests/alerts.sql`, 8 alert kinds |
| Alert **delivery** to a destination | **DEFERRED** | owner decision 2026-09-22: database rows only. No outbox, no worker, no webhook. **Nothing pages anyone.** A person must look |
| Backup restore rehearsal | **BLOCKED — no backups exist** | checked 2026-09-23: `supabase backups list` returns `backups: []`, `pitr_enabled: false` (Free plan). Nothing to restore until the Pro upgrade (daily backups, 7-day retention); the only fallback is a manual `supabase db dump --linked` |
| Rollback rehearsal | **PASS (local stack) 2026-09-23**, production PENDING | kill switch, drain, function rollback and re-enable rehearsed locally; rollback to any revision before `73cd5cb` FAILS on schema `0033`. Production rollback and `wrangler rollback` never executed. See §10, 2026-09-23 |
| Cohort rollout record | PENDING | Task 7 Step 8 |

### Trend assets — closed 2026-09-22

All twelve thumbnails in `public/trends/` were generated with `gpt-image-1` at
low quality (~$0.50), resized to 160px webp, and each one was looked at rather
than merely counted: every image matches the trend it is named for. `npm run
check:assets` reports 12/12. The gate stays in `verify-all` — it is the only
thing in the repository that would notice if an asset went missing again.

## 7. R01–R28 closure

R27 (request deadlines and quotable error ids) closed in this plan:

- Every client request carries a deadline — 30s reads, 120s uploads
  (`REQUEST_TIMEOUT_MS`, `UPLOAD_TIMEOUT_MS`). Before this **no request had a
  deadline at all**, which made the 408 and 504 copy unreachable.
- Every response carries `x-request-id`. Every 5xx body carries `errorId`, the
  same string, and the same string is on the `app_errors` row. A 4xx carries no
  id, deliberately.
- `error.requestId` is still emitted alongside `errorId` so a shipped client
  reading the old name is not blinded.
- Proof: `supabase/functions/api/error_id_test.ts` (10 tests) and
  `src/app/core/api/api-service.spec.ts` R27 block (9 specs).

R28 (the manifest) closed in this plan: `GET /manifest` reports `gitRevision`,
`workerVersion`, `deployedAt`, `schemaVersion`, `catalogVersion`,
`quoteVersion` and per-family capabilities; it is public, it survives a missing
RPC by reporting `unknown` rather than a stale guess, it agrees with
`/capabilities`, and it leaks no secret. Proof:
`supabase/functions/api/manifest_test.ts` (6 tests).

Earlier R-items are closed in their own plans' verification logs, linked from
`docs/superpowers/plans/2026-09-20-release-hardening-index.md`.

## 8. Decisions D1–D7

| Decision | Answer | Where enforced |
|---|---|---|
| D1 launch grant | Full plan credits on launch-coupon invoices | P2 Task 4; `stripe-webhook` tests |
| D2 retention | No lapse grace — purge the day the paid period ends; 7-year financial retention; 12-month moderation evidence hold | `0021`; `supabase/tests/deletion.sql`; `docs/superpowers/specs/2026-09-20-retention-policy.md` |
| D3 background-completion promise | Enabled only after deployed offline-completion proof — **not yet deployed** | P5 Task 5; `job-worker`; this document |
| D4 locales | **DECIDED 2026-09-22 — English-only.** `LOCALE_ID` = `en-US` in `src/app/app.config.ts`; `vansen.md` no longer promises ms. `docs/superpowers/specs/2026-09-20-launch-locales.md` |
| D5 library video references | Uploads only for the first release | P8 Task 3; composer copy |
| D6 completion notifications | **UNRESOLVED** — mobile MT-04 receipt has not passed. Notification claims stay hidden | P4 Task 6 + P5 Task 5 + mobile MT-04 |
| D7 video live state | **NOT LIVE.** `0016_video.sql` is applied locally and in production, but all five video families are `enabled = false`, `RUNWAY_API_KEY` is unset, R2 CORS and the `storage_config.r2_bucket` row do not exist | Task 2 inventory §4; to be re-confirmed from the manifest at Task 7 Step 10 |

## 9. What is not deployed

| Item | State |
|---|---|
| `0025_release_telemetry.sql` | **applied to production 2026-09-22.** See §10 |
| `api` | **v67**, revision `723fddd`, stamped 2026-09-23T00:09:56Z. See §10 |
| `stripe-webhook` v33, `appstore-webhook` v23, `job-worker` v22, `cleanup-worker` v19 | deployed and attested with `723fddd`. See §10 |
| `GIT_REVISION`, `DEPLOYED_AT`, `WORKER_VERSION` | set; the manifest reports `723fddd` / `v22`, schema `0033` |
| `0032_persona_references.sql` | **applied to production 2026-09-22.** The `persona` family ships `enabled = false`. See §10 |
| `0033_drop_schema_drift.sql` | **applied to production 2026-09-23.** Dropped the hand-made `public.admins` (0 rows) and `profiles.monthly_budget` (all null). Read-back: both gone, latest migration `0033`. `supabase db diff --linked --schema public` now shows only the platform default grants (inert, inventory §2) and the `pg_net` extension record living in `public` on the hosted project; no tables or columns differ |
| `RUNWAY_API_KEY` | unset |
| R2 CORS policy, `storage_config.r2_bucket` row | not created |
| FLUX retail price | deferred by owner decision 2026-09-22; decide before enabling `flux` |
| `public.admins`, `profiles.monthly_budget` | production drift — no migration creates them, no code reads them. Decision pending |

---

## What a reader should conclude

The backend and the web client are in good shape and the automated evidence for
that is real and reproducible. The release is not qualified. Three things stand
between here and a defensible launch, and none of them is code: a staging
environment (or an explicit written acceptance of its absence), a pass through
Gate B with a real browser and real accounts, and the production deployment in
Task 7 — which is the user's to authorise, one step at a time.

---

## 10. Production deployment log

Each entry is what was run, what was checked afterwards, and by what evidence.

### 2026-09-22 — migration `0025_release_telemetry.sql`

`supabase db push --linked --skip-vault`. `--skip-vault` was deliberate: the
production Vault holds `job_worker_secret` and `cleanup_worker_secret`, which
`0024`'s per-tick guard depends on, and `config.toml` carries no vault section
that should ever overwrite them.

Verified against the live database immediately afterwards:

| Check | Result |
|---|---|
| `supabase migration list --linked` | `0025` present local **and** remote |
| `public.fn_schema_version()` | `0025` |
| Functions created | `fn_schema_version`, `fn_raise_alert`, `fn_check_alerts`, `fn_resolve_checked_alerts` all present in `public` |
| `public.alerts` | exists, `relrowsecurity = true` |
| `cron.job` | `check_alerts` active, `*/5 * * * *` |
| **`select public.fn_check_alerts()`** | **`[]`** — executed cleanly against the real schema and reported nothing firing |

That last row is the one that matters. A monitoring function that errors in
production would log a failure every five minutes and alert nobody — exactly
the silence it exists to break. Running it once by hand proved all eight
queries work against the real tables, and proved that at this moment there are
no unfulfilled purchases, no media-less completions, no stuck jobs, trainings
or deletions, no dead notifications, no provider burn and no moderation surge.

Still outstanding from the runbook: the three manifest secrets, R2 CORS and the
`storage_config.r2_bucket` row, and the function redeploys — including
`stripe-webhook` and `appstore-webhook`, which are still the pre-P2 versions.

### 2026-09-22 — secrets, `api`, and the two stale webhooks

Deployed from commit `c4a6953` (the P9 work; `eff7552` implemented it,
`c4a6953` is the reviewed state).

| Function | Was | Now | Note |
|---|---|---|---|
| `api` | v49 (2026-09-21) | **v51** | first deploy carrying `/manifest` and the error id |
| `stripe-webhook` | v19, **2026-07-15** | **v21** | two months stale; the only writer of `topup` ledger rows |
| `appstore-webhook` | v9, **2026-07-18** | **v11** | |
| `job-worker` | v9 | v9 | unchanged |
| `cleanup-worker` | v8 | v8 | unchanged |

Secrets set (names and non-sensitive build metadata only; no credential was
read or written by Claude, and both `supabase secrets set` and `functions
deploy` were run by the owner after the permission classifier refused them):
`GIT_REVISION=c4a6953`, `WORKER_VERSION=v51`,
`DEPLOYED_AT=2026-09-21T19:12:50Z`.

**The manifest, read from production afterwards:**

```
gitRevision    c4a6953
workerVersion  v51
deployedAt     2026-09-21T19:12:50Z
schemaVersion  0025
catalogVersion 2026-09-21.1
capabilities   gpt-image, seedream, upscaler, flux, edit-remove, edit-fill,
               edit-expand, edit-bg, nano-banana, persona  = ON
               veo, omni, kling, runway, seedance          = OFF
```

That capability block is **D7 confirmed from the running system**, not from a
document: every video family is off.

**Error id verified live**, and behaving as designed:

| Request | Result |
|---|---|
| `GET /api/profile` with no token | `401`, header `x-request-id: 67ddf376`, body `{"error":{"code":"unauthorized","message":"Missing token"}}` — **no `errorId`**, because a 4xx is the caller's to fix |
| `GET /api/health` | `200` with an `x-request-id` — every response is traceable, not only the failures |

Remaining from the runbook: R2 CORS and the `storage_config.r2_bucket` row; the
backfills and reconciliation; and the staged family rollout. Gates A and B are
untouched, so this is a deployed candidate, not a qualified release.

### 2026-09-22 — backfill and reconciliation

**Thumbnails:** 9 generations had no thumbnail (every one predating `0022`).
`scripts/backfill-thumbnails.ts --max 50` processed 9, 9 ready, 0 failed, 0
unsupported. The registry went from 9 rows to 18 — the backfill registers each
thumbnail through `fn_record_thumbnail`, so it does not create the very orphans
the inventory looks for.

Two corrections to the runbook came out of this: the script is `.ts` on Deno
(not `.mjs` on Node, and there is no `--dry-run`), and it needs
`--node-modules-dir=none`, because the repository's `package.json` puts Deno in
manual mode and it then hunts for `@supabase/realtime-js` in `node_modules` and
dies before reading a row.

**Billing:** `fn_paid_unfulfilled` returns **0** over 7 days and **0** over all
time. Run through `supabase db query --linked`, which needs no service-role key
— the script is a single RPC call.

**Storage: 21 orphans. This is a real finding and it stops the rollout.**

| | |
|---|---|
| Objects in the buckets | 39 (`media` 34, `uploads` 5) |
| Registered in `storage_objects` | 18, all created 2026-09-21 or later |
| Orphans | **21**, all created **2026-07-09 → 2026-07-15** |
| Total size | ~34 MB across 6 owner prefixes |
| Referenced by `generations` | **0** |
| Referenced by `uploads`, `personas`, quarantine evidence | **0** — all three tables are empty |
| Owners still in `auth.users` | **none of the 6** |

What this is: bytes from July development that predate both the upload registry
(`0017`) and the deletion outbox (`0021`). The registry was introduced without
backfilling the objects that already existed, so it has never known about them.
No current code path produces an orphan — the inventory is doing exactly what it
was built to do, on history rather than on a live defect.

**Why it is not merely untidy.** Every one of the six owning accounts is gone
from `auth.users`, and their media is still in the bucket. Under D2, account
deletion removes owned objects. These accounts were deleted before the machinery
that does that existed, so production is currently holding media belonging to
deleted users. That is a retention question, not a housekeeping one.

**Not resolved here, deliberately.** Deleting them is destructive and is the
owner's call. The auditable route is two steps, because `deletion_outbox`
references `storage_objects(id)`: register the 21 objects, then enqueue them
with `fn_enqueue_deletions(..., 'pre_registry_backfill')` and let the cleanup
worker remove them with a record. The alternative — a raw storage delete —
leaves no evidence that it happened or why, which is the thing P6 exists to
prevent.

### 2026-09-22 — the orphans, binned through the audited path

Owner decision: bin them. Done in two steps rather than a bucket wipe, because
`deletion_outbox.object_id` references `storage_objects(id)` and a raw delete
would leave no record that it happened or why:

1. The 21 objects were registered (`user_id` null — every owning account is
   already gone from `auth.users`; `purpose` = `upload` for the `uploads`
   bucket, `media` otherwise).
2. `fn_enqueue_deletions(..., 'pre_registry_orphan_july_2026')` queued all 21.

| | Before | After |
|---|---|---|
| Files in buckets | 39 | **18** |
| Orphans | 21 | **0** |
| `deletion_outbox` completed | 0 | **21** |
| `storage_objects` state `gone` | 0 | **21** |

The 18 that remain are exactly the 9 live generations and their 9 thumbnails.

**This was also the first time P6's deletion machinery ran in production.** The
whole chain — `pg_cron` → Vault secret → `cleanup-worker` → storage delete →
confirmation written back — had only ever been exercised locally. It drained 21
objects on the first tick with zero failures and zero dead letters. That is a
better proof of the deletion path than any test, and it arrived as a side
effect of cleaning up July's mess.

### 2026-09-22 — provider costs, checked against published sources

Opened while comparing Runway's prices on the owner's request. The comparison
itself was invalid, and finding out why matters more than the comparison.

Runway Dev is now a **model router** reselling other providers' models at
$0.01/credit. Our own mapping (`_shared/providers/index.ts`) goes **direct** for
everything Runway would resell: `gpt-image` → OpenAI, `nano-banana`/`veo`/`omni`
→ Google, and fal only for `flux`, `seedream`, `upscaler`, `persona`, the four
`edit-*` tools, `kling` and `seedance`. A reseller cannot be cheaper than going
direct, so when the comparison said Runway undercut us on GPT Image, the
conclusion to draw was about our numbers, not theirs.

Two confirmations that `GPT_COST` in `model-families.ts` is wrong:

- The comment above it says the 4K multiplier is a "ratio from Runway's
  published credit table — verify exact token math". Our OpenAI costs were
  partly derived from a **reseller's** price list, and flagged as unverified at
  the time.
- **OpenAI no longer prices image models per image.** `gpt-image-2.5-sunburst`
  and `gpt-image-2.5-flare` are billed per token: $30.00/1M output, $8.00/1M
  image input, $5.00/1M text input. A flat per-image table cannot express that
  at all.

**Correction to an earlier claim in this session.** I first wrote that the cost
table was "not trustworthy". That was overbroad and wrong. Nine of the eleven
values I could check match the providers' published rates **exactly** — Veo's
nine-way rate table, Nano Banana 2 and Pro, Seedream v4, Kling v3 Pro and
Seedance 2.5 are all correct to the last digit. The full audit with source URLs
is in `docs/superpowers/specs/2026-09-22-catalog-refresh.md`. The real problems
are narrower, and one of them is urgent.

Also corrected: `nano-banana` is **not** a generation behind. Our `standard`
tier already calls `gemini-3.1-flash-image` (Nano Banana 2) and `pro` calls
`gemini-3-pro-image` (Nano Banana Pro). The `fast` tier is the problem — see
the catalog refresh spec.

Owner decisions on the same date: **do not switch providers**; **no MiniMax**
(H3 / H3 Max declined); and FLUX pricing, Stripe live mode and video enablement
are deliberately held until last.

A second correction, owed to the owner who caught it: I described `runway` as a
"direct" provider. The adapter exists in `providers/index.ts`, but
`RUNWAY_API_KEY` has never been set and the family is `enabled = false` in the
live manifest. **No Runway generation has ever run.** Reporting a code mapping
as an operating integration was the same mistake as reporting `api` v44 when it
was v49: describing a file instead of checking the running system.

### 2026-09-22 — catalog refresh deployed

Commit `81552a1`, `api` **v55**. Read back from production:

```
gitRevision    81552a1      ← matches the commit
workerVersion  v55
deployedAt     2026-09-21T20:17:39Z
schemaVersion  0025
catalogVersion 2026-09-22.1 ← the proof the new bundle shipped
```

`catalogVersion` moving from `2026-09-21.1` is what establishes that the new
`_shared` bundle actually went out, and with it the change that matters:
`nano-banana` **fast** no longer calls `gemini-2.5-flash-image`, which Google
shuts down on **2026-10-02**. That failure is averted with eleven days to
spare. Also live: `gpt-image` version 1 withdrawn, 2.5 Flare and 2.5 Sunburst
added.

The first read after deploy reported `workerVersion v51` against an actual v55
— the secret had been set from the previous deploy and no longer matched. The
manifest catching its own staleness is the mechanism working, not failing.

**Not yet done:** the new Dart fixture in `contracts/catalog/` has not been
handed to the mobile repo, so mobile is one catalog version behind.

### 2026-09-22 — review fixes, staging grants, cleanup (`c4ba8e4`)

Ships the post-implementation-review fixes (`5b5ddca`), the staging grants
migration (`a2a968a`) and the cleanup commit. Recorded 2026-09-23 by reading
the running system back; the deploy itself was run 2026-09-22.

Migrations: `supabase migration list --linked` shows **0026–0031** applied
remotely (review recovery, billing receipts, request-rate limits, job
resolution, legacy grant RPCs dropped, service_role table grants).

```
gitRevision    c4ba8e4      ← matches HEAD
workerVersion  v17          ← matches job-worker's own version, not api's
deployedAt     2026-09-22T11:14:01Z
schemaVersion  0031
catalogVersion 2026-09-22.4
```

| Component | Live version | Last updated (UTC) |
|---|---|---|
| `api` | v63 | 2026-09-22 07:55 |
| `job-worker` | v17 | 2026-09-22 11:13 |
| `stripe-webhook` | v29 | 2026-09-22 11:13 |
| `appstore-webhook` | v19 | 2026-09-22 11:13 |
| `cleanup-worker` | v15 | 2026-09-21 15:53 |

`/capabilities` reports catalog `2026-09-22.4`; the web app returns 200. The
`job-worker` bundle catalog is no longer `2026-09-21.1`, so the review's stale
bundle finding is closed.

One discrepancy: `updated_at` for `api` and `cleanup-worker` predates the
11:14 stamp and the 11:06 commit. `supabase secrets set` bumps the version
without touching `updated_at`, which may explain `api`. Neither `cleanup-worker`
nor `api` can be proven from this read alone to carry `c4ba8e4`. The
per-component receipt from that run was not kept. Confirm on the next
`./deploy.sh`, which attests all five.

Capabilities live: every image family and edit tool, `flux` included (its
retail price is still an open owner decision), `persona`; all five video
families `false`. This is a deployed candidate, not a qualified release:
smokes, Gate B and the rehearsals are still owed.

### 2026-09-22 — full `./deploy.sh` run (`c16b7fd`)

Run 2026-09-22T18:21Z (2026-09-23 02:21 MYT) with `./deploy.sh --yes` from a
clean `main`. Every gate passed, with `npm run verify` against a freshly started local
stack. All five functions were then deployed, the Cloudflare worker went out,
the manifest was stamped, and every read-back check matched. No migration
changes: production stays at 0031.

Component receipt:

| Component | Version | Revision |
|---|---|---|
| `api` | v64 | `c16b7fd` |
| `job-worker` | v19 | `c16b7fd` |
| `cleanup-worker` | v17 | `c16b7fd` |
| `stripe-webhook` | v30 | `c16b7fd` |
| `appstore-webhook` | v20 | `c16b7fd` |

```
gitRevision    c16b7fd
workerVersion  v19
deployedAt     2026-09-22T18:21:59Z
schemaVersion  0031
catalogVersion 2026-09-22.4
```

This closes the discrepancy in the entry above: all five components, `api`
and `cleanup-worker` included, are now proven to run the same committed
revision. Still a deployed candidate, not a qualified release.

### 2026-09-22 — FLUX Dev removal and persona as saved references (`73cd5cb`)

Run 2026-09-22T23:14Z (2026-09-23 07:14 MYT). Pre-check on production first:
no persona job in flight (`jobs` joined to `generations` on `family_id =
'persona'`, state not `done`: 0), no personas, no open training jobs.

Then `./deploy.sh --yes` from a clean `main`: every gate passed (`npm run
verify` against a freshly started local stack), all five functions deployed,
the Cloudflare worker went out, the manifest was stamped and read back.
Immediately after, `supabase db push --linked` applied
`0032_persona_references.sql` (the only pending migration).

Component receipt:

| Component | Version | Revision |
|---|---|---|
| `api` | v66 | `73cd5cb` |
| `job-worker` | v21 | `73cd5cb` |
| `cleanup-worker` | v18 | `73cd5cb` |
| `stripe-webhook` | v32 | `73cd5cb` |
| `appstore-webhook` | v22 | `73cd5cb` |

```
gitRevision    73cd5cb
workerVersion  v21
deployedAt     2026-09-22T23:14:58Z
schemaVersion  0032
catalogVersion 2026-09-23.2
```

Read back from production after the push:

| Check | Result |
|---|---|
| `training_jobs` table | dropped |
| `reconcile_stale_trainings` cron | gone |
| `fn_set_persona_photo`, `fn_persona_photos_valid`, `fn_persona_photos_complete` | present |
| `models.enabled` for `persona` | `false` |
| `provider_artifact_deletions` rows closed as `unsupported` | 0 (none were open) |
| Cron runs at 23:13–23:15 (`drive_job_worker`, `reconcile_stale_jobs`, `check_alerts`, `advance_account_deletions`, `reap_deleted_content`, `drive_cleanup_worker`) | all `succeeded` |
| `GET /api/personas` without a token | 401 |

Not yet done: enabling `persona`, the persona smoke, the Nano Banana
reference-edit smoke (the Google adapter now sends the prompt after the
images), and the two owner-run scripts. Still a deployed candidate, not a
qualified release.

### 2026-09-23 — schema drift dropped (`723fddd`)

`0033_drop_schema_drift.sql` was applied first (`supabase db push --linked`),
then `./deploy.sh --yes` exited 0: `DEPLOYED 723fddd · catalog 2026-09-23.2 · api v67`.
No function code changed; the redeploy restamps the manifest.

| Component | Version | Revision |
|---|---|---|
| `api` | v67 | `723fddd` |
| `job-worker` | v22 | `723fddd` |
| `cleanup-worker` | v19 | `723fddd` |
| `stripe-webhook` | v33 | `723fddd` |
| `appstore-webhook` | v23 | `723fddd` |

```
gitRevision    723fddd
workerVersion  v22
schemaVersion  0033
catalogVersion 2026-09-23.2
```

### 2026-09-23 — rollback rehearsal (local stack)

Runbook §8, rehearsed against `npm run db:test:start` (CLI 2.114.0, 34
migrations, `fn_schema_version()` = `0033`) and `npm run stage:seed`, with the
production flag set mirrored locally from a select-only `supabase db query
--linked` (on: the four `edit-*`, `flux`, `gpt-image`, `nano-banana`,
`seedream`, `upscaler`). `supabase/.env.staging` had every provider key blank,
so no provider was called and nothing was spent. Moderation (OpenAI) is
therefore unavailable locally: an enabled family is refused *after* the kill
switch with `moderation_unavailable`, uncharged. In-flight work was created
with `fn_reserve_generation`, the RPC and argument shapes the gateway sends,
as the `studio@` / `pro@` staging accounts, and driven by the real job-worker
(`POST /functions/v1/job-worker`). A provider's "failed" answer was
simulated by calling `fn_settle_job`, the RPC the worker's poll path calls.
Raw logs: session scratchpad `rollback/`.

**1. Disable one family mid-flight — PASS.** Four jobs in flight (flux: input
deleted while queued, cancel requested while queued, already at the provider;
nano-banana: input deleted).

```
$ POST /api/generations flux   (flux enabled)
{"error":{"code":"moderation_unavailable",...}} http=503
$ update public.models set enabled = false where id = 'flux';
$ POST /api/generations flux
{"error":{"code":"model_disabled","message":"This model is temporarily unavailable."}} http=503
$ POST /api/generations nano-banana
{"error":{"code":"moderation_unavailable",...}} http=503
studio balance 1458, ledger rows 5          -- unchanged by the three requests
$ job-worker tick
{"claimed":3,"ran":3,"failed":0,"notifications":0} http=200
flux        failed  generation_failed  charged 10  refund rows 1  refunded 10
flux        failed  cancelled          charged 10  refund rows 1  refunded 10
flux        pending submitted          charged 10  refund rows 0
nano-banana failed  generation_failed  charged 12  refund rows 1  refunded 12
$ fn_settle_job(<flux at provider>, 'failed', ...)
{"settled": true, "previous": "pending", "refunded": 10}
$ fn_settle_job replayed on two settled jobs; tick again
{"settled": false, "previous": "failed", "refunded": 0}   (x2)
{"claimed":0,"ran":0,"failed":0,"notifications":0} http=200
studio balance 1500, ledger rows 9          -- every charge refunded exactly once
```

**2. Disable all submissions — PASS.** Three more in flight (seedream and
gpt-image queued, nano-banana at the provider; two users).

```
$ update public.models set enabled = false;          -- UPDATE 15
$ POST generate nano-banana / gpt-image / seedream / flux (studio), nano-banana (pro)
model_disabled http=503                              (x5)
$ POST /api/generations/<failed nano-banana>/retry
{"error":{"code":"family_disabled","message":"That model is temporarily unavailable."}} http=409
$ GET /api/capabilities
{"enabledFamilyIds":[],...}
all ledger rows 16 before and after the requests
$ tick → {"claimed":2,"ran":2,...} ; fn_settle_job(<at provider>) → {"settled": true, "refunded": 12}
pending generations 0, jobs not done 0, charges since the switch 0
```

The first retry answered 500: the hand-built snapshot lacked `settings`
(`validateSettings` read `undefined`). A rehearsal artefact, not a product
path — a real snapshot always carries settings. With the snapshot completed
the retry answered 409 as above.

**3. Redeploy the previous functions — PASS for `73cd5cb`, FAIL for `76bc2a0`.**
Served from `git archive <rev> supabase/functions supabase/config.toml`
(extracted under `$HOME`; Docker mounts `/private/tmp` empty and the runtime
fails with "failed to determine entrypoint") with `supabase functions serve
--workdir <tree>`, two jobs queued under `723fddd` before each switch.

```
-- 73cd5cb (git diff 73cd5cb 723fddd -- supabase/functions: empty)
manifest   {"schemaVersion":"0033","catalogVersion":"2026-09-23.2",...}
tick       {"claimed":2,"ran":2,"failed":0,"notifications":0} http=200
           flux failed/refunded 10, nano-banana cancelled/refunded 12
POST flux  model_disabled http=503
GET /api/personas  {"items":[],"slots":{"used":0,"max":2}} http=200

-- 76bc2a0 (last migration it knew: 0031)
manifest   {"schemaVersion":"0033","catalogVersion":"2026-09-23.1",...}
tick #1    Internal Server Error http=500   -- the two queued jobs DID settle and refund first
tick #2    Internal Server Error http=500   -- every tick, with nothing queued
log        fn_claim_training_jobs: Could not find the function public.fn_claim_training_jobs(p_limit) in the schema cache
POST /api/personas {"name":"rehearsal","attested":true}
           {"error":{"code":"create_failed",...}} http=400
notification_outbox: the failure created under 76bc2a0 sat at attempts 0 until 723fddd ticked again
```

`76bc2a0` and every older revision carry the same training code
(`_shared/jobs/training.ts`, `fn_reserve_training`, `lora_url`,
`photo_paths`), so all of them fail the same way. No revision checked reads
`public.admins` or `profiles.monthly_budget` (0033), or `fn_cycle_reset` /
`fn_grant_pack` (0030).

Manifest after a function-only rollback, with the secrets the 723fddd deploy
stamped:

```
{"gitRevision":"723fddd","workerVersion":"v22","deployedAt":"2026-09-23T00:09:56Z","schemaVersion":"0033","catalogVersion":"2026-09-23.1"}
```

It names the old revision. Only `catalogVersion` comes from the code. The
restamp step in runbook §8 is required after any rollback.

**4. Re-enable — PASS.** Back on the working tree (`723fddd`).

```
ledger before   cycle_reset 2 / 5250   generate 11 / -121   refund 11 / 121
$ update public.models set enabled = true where id in (<the nine>);   -- UPDATE 9
$ tick x2 → {"claimed":0,...} http=200 (x2)    -- nothing settled is re-dispatched
$ POST flux → moderation_unavailable http=503  -- past the kill switch, uncharged
$ fn_settle_job replayed on all 11 rehearsal jobs → settled_again 0, refunded_again 0
$ fn_apply_fulfillment('stripe','seed:studio@staging.vansen', ...) replayed
{"replay": true, "applied": false, ..., "ledgerDelta": 1500}
ledger after    cycle_reset 2 / 5250   generate 11 / -121   refund 11 / 121
refund notes appearing twice: 0; 11 of 11 generations refunded in full exactly once
cycle_reset rows per user: 1 and 1; balances free 0, studio 1500, pro 3750
```

The replayed grant reports `ledgerDelta: 1500` while writing no row
(`applied: false`); the ledger is the evidence, not that field.

Existing gates re-run on the same database: `dispatch.sql`,
`job_settlement.sql`, `job_resolution.sql` exit 0, and
`settlement_concurrency.sh` prints "OK: single terminal transition (failed,
refunded 40, notifications 0)". `npm run test:sql` stopped at `alerts.sql` ("a
healthy system must be silent") because the rehearsal's `moderation_unavailable`
alerts were still open; `npm run verify` resets the database first and is
unaffected.

Read-only production checks the same day: `supabase functions list` → `api`
v67, `job-worker` v22, `cleanup-worker` v19, `stripe-webhook` v33,
`appstore-webhook` v23, all `verify_jwt=false`; `/manifest` → `723fddd`, `v22`,
schema `0033`, catalog `2026-09-23.2`; `npx wrangler deployments list` → latest
version `a5b95faa` (2026-09-23T00:09:51Z), before it `029ca6d3` (23:14:53Z) and
`b55be9fd` (18:21:52Z), none with a message or tag.

**Not proven:**

- any rollback on production: no function was redeployed and no secret set
- `wrangler rollback`: only the read-only list was run
- the poll path of a job at a provider under a rolled-back worker, and a
  `done` settlement with real media: no provider key, so provider answers were
  simulated with `fn_settle_job`. `job_settlement.sql` covers the `done` path
- push delivery: no FCM account locally, every outbox row ends `push_not_configured`
- cron-driven ticks: the local worker was ticked by hand
- `cleanup-worker` under a rolled-back tree (it needs `CLEANUP_WORKER_SECRET`,
  absent locally); its directory is unchanged since `5b5ddca`, but its bundled
  `_shared` is not

### 2026-09-23 — server-driven catalog (`bd6e3bc`)

`./deploy.sh --yes` exited 0: `DEPLOYED bd6e3bc · catalog 2026-09-23.2 · api v69`
(job-worker v24, cleanup-worker v21, stripe-webhook v35, appstore-webhook v25). Additive: new
public `GET /catalog`, optional `catalogVersion` → 409 `catalog_stale`, `subscription.entitled`
on `/profile`. Spec `specs/2026-09-23-server-driven-catalog-design.md`.

Read-back:

| Check | Result |
|---|---|
| `GET /catalog` | 200, `etag: "2026-09-23.2-d26c4fb4"`, `cache-control: public, max-age=300` |
| same with `If-None-Match` | 304 |
| families | nano-banana, gpt-image, flux, seedream on; veo, omni, kling, runway, seedance off; persona flat 46, off |
| `/profile` unauthenticated | 401 (unchanged) |
| `subscription.entitled` | covered by `profile_entitled_test.ts`; not read back live (needs a signed-in token) |

Mobile (`vansen-mobile` `52ed3bc`, local commit, no remote) renders this catalog; no store build.

### 2026-09-23 — mobile personas, catalog 2026-09-23.3 (`4588a10`)

`./deploy.sh --yes` exited 0: `DEPLOYED 4588a10 · catalog 2026-09-23.3 · api v71`. Additive:
`flat.persona` gains photoSlots, minEdge, maxBytes, maxNameLength, planSlots, aspectRatios, batch
(`a012c42`); `CATALOG_VERSION` bumped because the served body changed (the fingerprint spec now
covers the whole `/catalog` body). Spec `specs/2026-09-23-mobile-personas-design.md`.

| Check | Result |
|---|---|
| `GET /catalog` | 200, `catalogVersion` 2026-09-23.3, `etag: W/"2026-09-23.3-d26c4fb4"` |
| same with `If-None-Match` | 304 |
| `flat.persona` | 46 credits, `enabled: false`, 5 slots front → right_profile, minEdge 1024, maxBytes 2621440, name 40, studio 2 / pro 5 / owner 5, ratios 1:1 3:4 4:3 16:9 9:16, batch 1–4 |

Mobile (`vansen-mobile` `bd6f644`, local, 510 tests) adds personas: list, create with consent,
five-slot detail with photo prep, composer persona chip. Persona stays off until the owner's smoke.

### 2026-09-23 — mobile parity phases 3+4, catalog 2026-09-23.4 (`b005993`)

`supabase db push --linked` applied `0034_edit_tools_pro.sql` (AI edit tools Pro, owner decision:
follow the web), then `./deploy.sh --yes` exited 0: `DEPLOYED b005993 · catalog 2026-09-23.4 · api v73`.
Spec `specs/2026-09-23-mobile-parity-phase34-design.md`.

| Check | Result |
|---|---|
| `GET /catalog` | 200, `catalogVersion` 2026-09-23.4, `etag: W/"2026-09-23.4-b6527d2c"`; `If-None-Match` → 304 |
| `flat.editTools[].plan` | pro for edit-remove, edit-fill, edit-expand, edit-bg (10/10/10/5 credits, enabled) |
| `flat.upscale` | 7 credits, enabled, plan studio (cloud upscale stays Studio, as the web sells it) |
| styles / trends | 20 styles with thumb + category + categoryLabel; 12 trends with thumb; `/styles/oil-painting.webp` and `/trends/90s-yearbook.webp` 200 `image/webp` from `https://vansen.vankode.com` |
| `GET /jobs` unauthenticated | 401 (unchanged); read failure now 503 `jobs_unavailable` (test-covered) |

Mobile (`vansen-mobile` `b2c4207`, local, 750 tests): cloud upscale + Edited-from link, styles and trends,
job cancel, Settings → Usage, password recovery (MT-06), AI edit tools Pro-locked, web origin fixed to
`https://vansen.vankode.com`. No store build.

### 2026-09-23 — clean-code revamp (`988777b`)

Behaviour-preserving refactor (spec `specs/2026-09-23-clean-code-revamp-design.md`): `app.ts`
4,112 → 57 lines (33 route/service/lib modules, route and middleware order identical, memos one per
`createApp`); `model-families.ts` → barrel over 20 modules (buildCatalog output byte-identical);
workspace-page, canvas-viewport, tool-options, edit-session split by concern. `npm run verify` 9/9 PASS;
tests unchanged except import paths. `./deploy.sh --yes` exited 0: `DEPLOYED 988777b · catalog
2026-09-23.4 · api v75`. Read-back: `/catalog` 200 at .4 with 9 families; `/profile` unauthenticated 401.

### 2026-09-24 — MCP connection, shipped dark (`887c9ce`)

Spec `specs/2026-09-23-mcp-connection-design.md` §R. The spike's Supabase OAuth 2.1 server was dropped
after the final review's C1 reproduced locally (`.superpowers/sdd/mcp/c1-repro.md`): its tokens are full
GoTrue sessions (password set, email change, global sign-out). Owner decision: our own authorization
server in `api` issuing opaque hashed tokens (`vsn_at_`/`vsn_rt_`) that only `/mcp` accepts. Two final
reviews, two fix waves. `supabase db push --linked` applied `0035_mcp_client.sql` and `0036_mcp_oauth.sql`;
`./deploy.sh --yes` deployed all five functions and the web Worker (its closing manifest curl hit a
transient HTTP/2 framing error; the read-back below replaces it). Supabase's OAuth server stays disabled.

| Check | Result |
|---|---|
| `GET <api>/manifest` | `gitRevision` 887c9ce, `schemaVersion` 0036, `workerVersion` v31, catalog 2026-09-23.4; `api` v77, `verify_jwt` false |
| `GET https://vansen.vankode.com/.well-known/oauth-authorization-server` | 200 `application/json`, `access-control-allow-origin: *`, issuer `https://vansen.vankode.com`, endpoints on `<api>/oauth/*` |
| Framing | `x-frame-options: DENY` + `frame-ancestors 'none'` on `/` and `/oauth/consent` |
| `GET <api>/mcp/.well-known/oauth-protected-resource` | 200, `authorization_servers` `["https://vansen.vankode.com"]`, scope `vansen` |
| `POST <api>/mcp`, `POST <api>/oauth/register` | 503 `mcp_disabled` (`MCP_ENABLED` unset) |
| Local e2e | MCP Inspector 2.7.0: PRM → metadata → DCR → consent → token → tools → refresh → revoke → 401; `vsn_at_` refused on `/profile` (401) and GoTrue `/auth/v1/user` (403) |

Mobile `5580fce`: sign-out pinned to local scope. Still owner-gated: set `MCP_ENABLED=on`, paid smoke with
Claude and ChatGPT (connect, one image each, revoke, next call fails), then the FAQ entry.
