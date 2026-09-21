# Settlement verification log (P4)

Evidence for `2026-09-20-release-hardening-p4-job-settlement.md`. The automated
suites prove the logic; this records what was actually run, on what, and what is
still owed.

## Automated suites — 2026-09-21

| Suite | Command | Result |
|---|---|---|
| Edge | `cd supabase/functions && deno test --allow-all _shared api stripe-webhook appstore-webhook` | **256 passed / 0 failed** |
| Type check | `deno check api/index.ts api/app.ts` | clean |
| Settlement routes | `deno test --allow-all api/settlement_routes_test.ts` | 10 passed / 0 failed |
| Shared finalizer | `deno test --allow-all _shared/jobs/store_test.ts` | 25 passed / 0 failed |
| Outbox drainer | `deno test --allow-all _shared/jobs/notifications_test.ts _shared/push_test.ts` | 16 passed / 0 failed |
| Save persistence | `deno test --allow-all api/save_persistence_test.ts` | 8 passed / 0 failed |
| SQL settlement | `psql "$VANSEN_LOCAL_DB" -f supabase/tests/job_settlement.sql` | 4 do-blocks, 6 cases, all green |
| SQL outbox | `psql "$VANSEN_LOCAL_DB" -f supabase/tests/notification_outbox.sql` | 5 do-blocks, 6 cases, all green |
| SQL race | `supabase/tests/settlement_concurrency.sh` ×3 + once with `0.3` | see below |

Local database: the `vansen-test-db` container on `localhost:55432`
(`supabase start` still does not work on this repo — `0008_age_gate` and
`0008_credit_plans` share a version prefix).

### Race proof

Four runs, both branches reached:

```
OK: single terminal transition (failed, refunded 40, notifications 0)
OK: single terminal transition (done,   refunded 0,  notifications 1)
OK: single terminal transition (failed, refunded 40, notifications 0)
OK: single terminal transition (done,   refunded 0,  notifications 1)   # with 0.3s cancel delay
```

Never `done` and refunded, never two notifications, never two refunds. With no
delay the cancel usually wins on this machine, which is why the script now takes
an optional delay argument — a race proof that only ever exercises one branch is
not a proof.

### Mutation checks (proof the suites are not vacuous)

| Mutation | Result |
|---|---|
| Remove the advisory lock + `for update` from `fn_settle_job` | 4 of 6 races produced "done AND refunded 40" |
| `if (row?.media_path === key) return;` removed from `dropLostObject` | 1 failure (a re-run of the winning attempt deleted the winner's media) |
| Orphan-check read error ignored | 1 failure |
| Per-attempt key made constant | 1 failure (loser overwrote the winner) |
| Unknown settlement treated as a lost race | 1 failure (object destroyed on an unknown outcome) |
| Byte budget / truncation guards removed | 2 failures |
| `if (saveError || !saved)` reduced to `if (saveError)` | 2 failures (zero-row update read as success) |
| Claim ignores a live lease | 1 SQL failure (a row claimed twice) |
| Ack ignores lease expiry | 1 SQL failure (an expired lease marked the row sent) |
| A failed delivery sets `sent_at` | 1 SQL failure |

## Byte ceilings — OPEN

`MAX_VIDEO_BYTES` is 128 MiB and `MAX_IMAGE_BYTES` 32 MiB. With a
`content-length` the reader allocates the destination once, so peak allocation
equals the file; without one it halves its own budget, because it must
concatenate chunks. Those numbers are reasoned against the edge runtime's memory
limit — **they have not been measured on the deployed runtime.** Before video
rollout, download a real 4K clip at the longest supported duration on the
deployed `api` and record the observed size and peak here. A ceiling set too low
refunds valid renders; set too high it OOMs mid-settlement.

## Failure rehearsal (Task 7)

"Covered" means the behaviour is proven against fakes and the local database,
which is not the same as proven against a deployed function. Every row that
needs a real provider, a real bucket or a real device is **not run**.

| Scenario | Expected | Method | Result |
|---|---|---|---|
| Storage rejects an image write | `failed`, refunded, no orphan object | `FakeStorage.failNext` — `api/settlement_routes_test.ts` R05 ×2, `_shared/jobs/store_test.ts` | covered (fakes) 2026-09-21 |
| Provider returns 429 mid-poll | stays `pending`, no refund | `retryable_failure` through `GET /jobs` — `settlement_routes_test.ts` R08 | covered (fakes) 2026-09-21 |
| Provider unreachable mid-poll | stays `pending`, no refund | thrown `TypeError` classified retryable — `settlement_routes_test.ts` R08 | covered (fakes) 2026-09-21 |
| Cancel while fal is queued | `cancelled`, refunded once | `cancel → 'cancelled'` — `settlement_routes_test.ts` | covered (fakes) 2026-09-21 |
| Cancel while fal is rendering | 409 `not_cancellable`, no refund | `cancel → 'too_late'` | covered (fakes) 2026-09-21 |
| Cancel while fal is unreachable | 503 `cancel_unconfirmed`, no refund | `cancel → 'unreachable'` | covered (fakes) 2026-09-21 |
| Success racing the stale sweep | one terminal state, orphan deleted | `settlement_concurrency.sh` ×4 and the losing-attempt tests | covered (local db) 2026-09-21 |
| Oversize body | refused before buffering, retried, refunded | `store_test.ts` declared-length and no-length cases | covered (fakes) 2026-09-21 |
| Truncated body | retried, then refunded | `store_test.ts` truncated/over-declared cases | covered (fakes) 2026-09-21 |
| Wrong content type | refused before buffering | `store_test.ts`, incl. an image generation handed a video | covered (fakes) 2026-09-21 |
| Duplicate notification delivery | one push per generation | `notifications_test.ts` two-drainer case + SQL double-claim | covered (fakes + local db) 2026-09-21 |
| Read-only `media` bucket, real run | `failed`, refunded, no orphan | needs a deployed function | **not run** — no staging project |
| Real 429 / blocked provider host | stays `pending`, no refund | needs real provider keys | **not run** — no staging project |
| Crash between push and ack | at-most-one visible notification | needs a deployed drainer + a real device | **not run** — no staging project, no drainer schedule (P5) |
| Client deduplicates on `notificationId` | one visible notification | mobile MT-04 receipt + deep-link proof | **not run** — D6 owns this; the id is now in the FCM payload |

### Orphan check after the rehearsal

```
select count(*) from public.generations
where status = 'done' and (media_path is null or media_path = '');
--> 0
```

## Delivery is not wired yet

`api` no longer pushes from inside a request: `fn_settle_job` queues the
notification in the same transaction as the settlement, and
`_shared/jobs/notifications.ts` drains it. **Nothing calls the drainer yet** —
P5 schedules it. Until then notifications accumulate in `notification_outbox`
and are not delivered. Nothing is deployed, so no customer is affected, but P5
must not be skipped.

## Live rehearsal — NOT RUN

Same blocker as the billing log: there is no staging project, `0019` is not
applied anywhere but the local container, and `api` has not been redeployed.
Every row of the failure rehearsal — read-only bucket, provider 429, killed
download, cancel against an unreachable provider — needs a deployed function and
must not be run against `bnorhcxhvxydkgvcxjad`.
