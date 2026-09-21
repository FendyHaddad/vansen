# P6 — durable deletion: verification log

Recorded 2026-09-21. Everything below was run against the local Postgres
container and the Deno/vitest suites in this repo. **Nothing here is
production proof**: the cleanup worker is not deployed, migration `0021` is
applied locally only, and no run has touched a real Supabase bucket or R2. The
open items at the end say exactly what that leaves unverified.

Policy source: `docs/superpowers/specs/2026-09-20-retention-policy.md` (D2).

## Suites

| Suite | Command | Result |
|---|---|---|
| Deletion lifecycle (SQL, 13 blocks) | `psql "$VANSEN_LOCAL_DB" -X -v ON_ERROR_STOP=1 -f supabase/tests/deletion.sql` | pass |
| Dispatch (SQL, P5) | `psql … -f supabase/tests/dispatch.sql` | pass |
| Edge functions, all | `cd supabase/functions && deno test --allow-all` | 398 pass |
| — object registry | `_shared/storage/registry_test.ts` | 9 |
| — deletion service | `_shared/storage/deletion-service_test.ts` | 16 |
| — cleanup worker | `cleanup-worker/` | 9 |
| — deletion routes | `api/deletion_routes_test.ts` | 14 |
| Inventory | `node --test scripts/storage-inventory.test.mjs` | 22 pass |
| Angular | `npm test -- --watch=false` | 261 pass |
| Build | `npx ng build` | clean |

`0021_durable_deletion.sql` was applied to the local database three times in a
row; it is idempotent, and the third run changed nothing.

## Mutations

A suite that passes against broken code proves nothing. Each mutation below was
introduced, the suite run, and the mutation reverted.

| # | Mutation | Expected to fail | Result |
|---|---|---|---|
| MA | `fn_bucket_for` returns `'media'` for every purpose | deletion.sql (block 2) | killed |
| MB | `fn_reap_generation` ignores a job that is not `done` | deletion.sql (block 5) | killed |
| MC | `fn_enqueue_deletions` queues objects under an unexpired hold | deletion.sql (block 9) | killed |
| MD | `fn_complete_deletion` accepts a stale lease token | deletion.sql (block 7) | killed |
| ME | `fn_advance_account_deletion` finalises with unresolved provider work | deletion.sql (block 10) | killed |
| M6 | `deleteObject` always uses the `media` bucket | deletion-service | killed |
| M7 | a delete call that returned is treated as proof of absence | deletion-service | killed |
| M8 | a lookup failure counts as "gone" | deletion-service | killed |
| M9 | the cleanup worker drops its "secret configured" check | cleanup-worker | killed (after adding the missing case) |
| M10 | the worker assumes `fn_complete_account_deletion` succeeded | cleanup-worker | killed |
| M11 | `objectKey` keys by path only | inventory (6 tests) | killed |
| M12 | `listSupabaseBucket` reads only the first page | inventory (3 tests) | killed |
| M13 | `reconcile` drops unknown objects instead of reporting orphans | inventory (2 tests) | killed |

M9 initially **survived**: every existing case compared a present header to a
present secret, so removing the "no secret configured" guard changed nothing.
The hole it left — a request with no header against a worker with no secret
configured — is now its own assertion.

## Rehearsal matrix

Each path was exercised end to end in the suite named, and the registry/outbox
state asserted afterwards. "Bytes removed" is asserted against the fake stores;
against a real bucket it is an open item.

| Path | Where | Rows | Objects queued | Notes |
|---|---|---|---|---|
| Delete one image | deletion.sql 1, deletion_routes 1 | gone | `media` only | the same key in `uploads` is untouched (block 2) |
| Delete a video | deletion.sql 3 | gone | file + poster, R2, configured bucket | never a presumed Supabase bucket |
| Delete an upload | deletion.sql 2 | — | `uploads` only | |
| Delete a persona | deletion.sql 4, deletion_routes 7 | gone | photos + ZIP | LoRA recorded as a provider REQUEST |
| Delete while a job runs | deletion.sql 5, deletion_routes 2 | tombstoned, kept | none yet | job asked to stop, never settled |
| Late provider output | deletion_routes 5 | reaped after the job settles | queued then | the bytes land somewhere we can still name |
| Delete twice | deletion.sql 6, deletion_routes 4 | idempotent | one row | a repeat never postpones the first cleanup |
| Whole account | deletion.sql 10, deletion_routes 11–14 | profile gone | all owned objects | ledger/billing/moderation anonymised |
| Account with work running | deletion.sql 11, deletion_routes 12 | profile kept | none yet | closure stays open |
| Lapse purge | deletion.sql 12 | at `current_period_end` | queued | no post-lapse grace (D2) |
| Failed backend | deletion-service, cleanup-worker | unchanged | stays queued | backoff, then dead letter at 12 |
| Stale lease | deletion.sql 7, deletion-service | unchanged | not acknowledged | zero-row update is never a success |
| Worker restart mid-batch | deletion-service | unchanged | remaining rows reclaimed | one bad object does not stop the batch |
| Quarantined evidence | deletion.sql 9, 10 | held | **not** queued | 12-month hold, reported in its own column |

## Money and evidence retention

Asserted in `deletion.sql` block 10: after closure the ledger entries,
`billing_transactions`, `billing_deliveries`, both provider-expense tables and
`moderation_events` all still exist, with `user_id` null and `deletion_ref`
pointing at the closure. `submissions` are deleted. No refund is issued by any
deletion path — cancellation only *asks*; only the lease holder settles a job,
so a delete cannot double-refund.

## What this does NOT prove

1. **No real store has been inventoried.** The local container is bare Postgres
   with no Storage API, so `scripts/storage-inventory.mjs` has only been run
   against its own fakes. Its first real run belongs in P9, against staging.
2. **The cleanup worker has never been deployed.** `drive_cleanup_worker` fails
   closed without the Vault secrets `cleanup_worker_url` and
   `cleanup_worker_secret`; neither is set outside the local container, where
   they hold placeholder values.
3. **No provider offers a verified artifact-deletion API.** The capability
   record (`docs/superpowers/specs/2026-09-20-provider-capability-record.md`)
   documents none, so nothing resolves a `provider_artifact_deletions` row.
   Every closure with a trained persona therefore stops at `processing` with
   `providerArtifacts > 0` — visibly unfinished, which is the honest state, but
   it will stay that way until someone records fal's actual capability (an API
   with evidence, or `unsupported`). **This needs a decision before release.**
4. **R2 has no bucket.** Video storage is still unrolled out (see
   `video-phase4b-rollout-pending`), so the R2 half of every path is proven
   only against the fake adapter.
5. **Byte-level absence on Supabase** is verified through `storage.list` with
   an exact-name match, because the service client has no per-object HEAD. That
   is the backend's supported existence query, not a stronger proof.

## Open items for P9

- Set `cleanup_worker_url` / `cleanup_worker_secret` in Vault and deploy
  `cleanup-worker` (it needs `_shared/storage/` bundled, including `r2.ts`).
- Redeploy `api`: every object writer now registers its locator first, and the
  deployed gateway does not.
- Decide and record fal's LoRA deletion capability; until then no closure with
  a persona can reach `completed`.
- First inventory run against staging, with `--json` output kept beside this
  log, before any production cleanup.
- Confirm the lapse-warning banner reaches customers *before*
  `current_period_end` — D2 shortens a window that shipped copy promised, and
  the copy change (Task 4 Step 4) and the cron change must ship together.
