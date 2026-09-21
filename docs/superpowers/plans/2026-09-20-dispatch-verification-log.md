# Durable dispatch — verification log (P5)

Recorded 2026-09-21. Covers `0020_durable_dispatch.sql`, `_shared/jobs/{lease,dispatch,payload,training}.ts`,
the new `job-worker` function, and the gateway's reservation path.

What this log can and cannot say: **nothing here was run against deployed
infrastructure.** There is still no staging project, `supabase start` is still
broken by the duplicate `0008` prefix, and `0020` has been applied only to the
local `supabase/postgres` container. Every row below is therefore either proven
against the local database, proven in-process against the real code with fake
transports, or explicitly **not run**.

## Suites

| Suite | Result |
|---|---|
| `deno test --allow-all _shared api job-worker stripe-webhook appstore-webhook` | 347 passed, 0 failed |
| `deno test --allow-all _shared/jobs` | 91 passed (80 + 11 training) |
| `deno test --allow-all api` | 105 passed |
| `deno test --allow-all api/dispatch_routes_test.ts` | 10 passed |
| `deno test --allow-all api/offline_completion_test.ts` | 4 passed |
| `deno test --allow-all api/settlement_routes_test.ts` | 11 passed |
| `deno test --allow-all job-worker` | 9 passed |
| `npm test -- --watch=false` | 258 passed, 0 failed |
| `psql -f supabase/tests/dispatch.sql` | 16 DO blocks, all assertions passed |
| `supabase/tests/caps_concurrency.sh` | OK — video slots, idempotency key, persona slots |
| `psql -f supabase/tests/job_settlement.sql` | passed |
| `psql -f supabase/tests/notification_outbox.sql` | passed |
| `deno check api/index.ts job-worker/index.ts stripe-webhook/index.ts appstore-webhook/index.ts` | clean |

## Rehearsal matrix

| Scenario | Expected | Where it was proven | Result |
|---|---|---|---|
| Submit a job, then close every client | Generation reaches `done` with media, driven only by the worker | `api/offline_completion_test.ts` — the route answers 202, then only authenticated worker ticks run | **PASS (in-process)**. Not yet run against a deployed function. |
| Submit, kill the worker mid-flight, restart it | Lease expires, another tick picks the job up, one result | same file, "a worker that dies mid-flight is replaced" (lease cleared after submit) and "a crash BETWEEN the call and the record" (state `submitting`, no reference) | **PASS**: one provider submit, the unknown case is held in `reconciling` and never refunded |
| Double-click submit (same key) | One charge, one generation, one provider call | `caps_concurrency.sh` (two concurrent calls, real advisory locks) + `generation-store.spec.ts` "a double click shares the in-flight request" | **PASS** |
| Retry with the same key after a client timeout | The original generation is returned, no second charge | `dispatch.sql` block 1 (replay returns the stored result) + `api/dispatch_routes_test.ts` + `generation-store.spec.ts` "a retry reuses the key" | **PASS** |
| Same key, edited prompt | 409 `idempotency_conflict`, nothing charged | `dispatch.sql` block 2 + route test | **PASS** |
| Four simultaneous video submissions | Exactly three accepted, the fourth refused with `too_many_jobs` | `caps_concurrency.sh` against the local database | **PASS** |
| A run that crosses the remaining daily budget | Refused with `daily_cap` and a reset time | `dispatch.sql` (user/global/provider windows, refunded work still counts) | **PASS** |
| Two concurrent persona creations at the slot limit | Exactly one accepted | `caps_concurrency.sh` | **PASS** |
| A provider that never answers | Kept in reconciliation with backoff and an alert; only a confirmed failure/cancellation settles | `_shared/jobs/dispatch_test.ts` + `training_test.ts`; `dispatch_reconcile_stuck` / `training_reconcile_stuck` after 10 attempts | **PASS** |
| A reference whose signed URL would have expired | Re-signed at submit time; the provider receives a working URL | `_shared/jobs/payload_test.ts` (clock advanced past expiry) + `api/reference_contract_test.ts` (route stores the path, the worker signs it) | **PASS** |

## Mutation checks

Each mutation was applied, the suite run, and the mutation reverted.

| # | Mutation | Result |
|---|---|---|
| M1 | `job-worker/handler.ts` stops comparing `x-worker-secret` | 3 failures — an unauthenticated tick would drive the whole queue |
| M2 | `runJob` treats `submitting` as fresh work instead of reconciling | 3 failures, including "a crash BETWEEN the call and the record" — paid work would be submitted twice |
| M3 | `submitTraining` ignores whether `fn_begin_training_submit` changed a row | 1 failure — a worker with no lease would start a second training run |
| M4 | The gateway ignores the client's `Idempotency-Key` and mints its own | 2 failures — every retry would be a new charge |
| M5 | `completionNotifications()` drops its background-completion requirement | 1 Angular failure — the UI would promise notifications a deployment cannot send |

## Copy gating (D3 / D6)

`ReleaseCapabilities` reads a manifest that P9 supplies; **absent reads as
false**, and both flags ship `false` in `src/environments/`. Wording per state
is enforced by `pending-video-card.spec.ts`:

| Verified state | Wording |
|---|---|
| Manifest missing/unreachable, or background completion unverified | "Keep this page open while it renders." — no promise |
| Background completion verified only | "You can leave this page and return to check the result." |
| Background completion **and** notification delivery verified | "You can leave this page. We'll notify you when it's ready." |

D6 stays unavailable on both platforms until the mobile MT-04 receipt (delivery
+ deduplication on `notificationId`) is recorded in P9 Task 6.

Cancellation copy changed with the contract: `POST /jobs/:id/cancel` now answers
202 and refunds nothing, so the client says "Cancelling — we'll refund if it
stops in time." and the item stays pending until the worker reports the real
outcome.

## Open items carried into P9

1. **Nothing is deployed.** `0016`, `0018`, `0019` and `0020` are applied only
   to the local container; the `api` function has not been redeployed and the
   `job-worker` function has never been deployed.
2. **The cron needs Vault entries before it can be applied anywhere.**
   `0020` now asserts `pg_net`, `pg_cron` and the secrets `job_worker_url` and
   `job_worker_secret`, and fails loudly if any are missing — by design. They
   were created locally with placeholder values; production values are a P9
   step. `pg_net` was absent locally and is now created by the migration.
3. **`JOB_WORKER_SECRET` must be set as an Edge Function secret** for
   `job-worker`, matching the Vault value, and the function must be deployed
   with every `_shared/` file (`jobs/`, `providers/`, `storage/`, `testing/`
   excluded).
4. **No provider exposes a lookup by our dispatch key.** `index.ts` wires
   `reconcile` to a constant `pending`: an unknown submit is held, backed off
   and alerted on, never resubmitted and never refunded on a guess. Recording a
   real reconciliation per provider is a P9/capability-record item.
5. **Byte ceilings are still unmeasured** (carried from P4).
6. **The notification drainer now runs** inside each worker tick, so P4's
   "nothing calls the drainer" gap closes the moment the worker is deployed —
   not before.
