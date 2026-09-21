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
| Backup restore rehearsal | PENDING | needs synthetic staging data — blocked with Gate A |
| Rollback rehearsal | PENDING | Task 7 Step 9 |
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
| D4 locales | **OPEN** — `docs/superpowers/specs/2026-09-20-launch-locales.md`. `vansen.md` still promises en + ms and still lists i18n as not started |
| D5 library video references | Uploads only for the first release | P8 Task 3; composer copy |
| D6 completion notifications | **UNRESOLVED** — mobile MT-04 receipt has not passed. Notification claims stay hidden | P4 Task 6 + P5 Task 5 + mobile MT-04 |
| D7 video live state | **NOT LIVE.** `0016_video.sql` is applied locally and in production, but all five video families are `enabled = false`, `RUNWAY_API_KEY` is unset, R2 CORS and the `storage_config.r2_bucket` row do not exist | Task 2 inventory §4; to be re-confirmed from the manifest at Task 7 Step 10 |

## 9. What is not deployed

| Item | State |
|---|---|
| `0025_release_telemetry.sql` | **applied to production 2026-09-22.** See §10 |
| `api` | **v49**, deployed 2026-09-21 — predates the manifest route and the error-id change |
| `stripe-webhook` v19, `appstore-webhook` v9 | last deployed **2026-07-15** and **2026-07-18** — two months before P2 rewrote them |
| `GIT_REVISION`, `DEPLOYED_AT`, `WORKER_VERSION` | unset, so the manifest would report `unknown` |
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
