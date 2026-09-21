# Release Hardening P6 — Durable Deletion and Storage Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a customer deletes a generation, a persona or their whole account, the bytes actually go — in both storage backends, eventually and verifiably — and every retained object has an owner, a policy reason or a durable cleanup record.

**Architecture:** Deletion stops being a best-effort loop inside a request. Every delete records the objects it orphaned into a `deletion_outbox` in the same transaction that removes the rows, and a cleanup worker drains that outbox with retries against Supabase Storage or R2. `fn_delete_account` and the lapsed-library purge, which today delete rows and nothing else, enqueue instead. A read-only inventory script reconciles storage against the database so the claim "deleted means deleted" is measured, not asserted.

**Tech Stack:** Postgres (plpgsql, triggers, `pg_cron`), Deno, Supabase Storage, Cloudflare R2.

**Source spec:** `docs/superpowers/plans/2026-09-17-release-readiness-review-and-implementation-plan.md` — this plan implements **T08**, closing **R11** and resolving decision **D2** (retention). It depends on P1 (test seam, upload registry `0017`) and P5 (worker pattern, `0020`). It is a prerequisite for P9's release gates.

## Global Constraints

- **Never commit, branch, or push.** Every task ends with "user commits". No `git commit` steps.
- **No nested if statements.** Guard clauses and early returns only.
- **Migration numbering:** P1 `0017`, P2 `0018`, P4 `0019`, P5 `0020`. This plan adds `0021`. Confirm the applied inventory first; never renumber an applied migration.
- **New RPCs are service_role-only.**
- **Never delete an object before the row that references it is gone.** The other order can strand a live row pointing at nothing, which looks to the customer like data loss.
- **Never let a storage failure block a row delete.** The customer asked for their data to be removed; a bad minute at the storage provider must not refuse them.
- **A delete is only complete when both halves are done.** Dropping the row and hoping about the object is what R11 is.
- **Account deletion is legally load-bearing.** It must be idempotent, resumable, and auditable. An account delete that half-ran and reported success is worse than one that failed loudly.
- **Tombstone pending content, request cancellation and retain lifecycle rows until settlement/reconciliation finishes.** Unsupported cancellation cannot justify deleting the tracking row.
- **Redeploying `api` must bundle every `_shared/` file.**
- **Tests:** Edge → `cd supabase/functions && deno test --allow-all _shared api job-worker cleanup-worker stripe-webhook appstore-webhook`. SQL → local stack only (`$VANSEN_LOCAL_DB`). Angular → `npm test -- --watch=false`.

---

## The defects in one paragraph

`fn_delete_account` is, in its entirety, `delete from public.profiles where id = p_user;` (`0001_foundation_schema.sql:102-105`). The cascade removes the rows; **every generated image, every video in R2, every persona training photo and every LoRA stays exactly where it was**, and the row that named its path is gone, so nothing in the system can ever find it again. The daily `purge_lapsed_libraries` cron (`0013_personas.sql:103-114`) has the same shape: it deletes `generations` and `personas` rows for lapsed subscribers with raw SQL and touches no storage. `DELETE /generations/:id` (`api/index.ts:2035-2057`) at least tries — but it deletes the row **first**, then deletes objects in a loop whose failures are logged and swallowed, so a storage hiccup leaves an object nobody can name. Persona deletion never removes `photo_paths` or the LoRA at all. And `storage_backend` exists only on `generations` (`0016_video.sql:6-7`), so nothing records which backend a persona's or an upload's object lives in.

---

## File Structure

**New:**
- `supabase/migrations/0021_durable_deletion.sql` — `deletion_outbox`, `fn_enqueue_deletions`, `fn_claim_deletions`, `fn_complete_deletion`, rewritten `fn_delete_account` and `fn_purge_lapsed`, `account_deletions` audit, backend columns.
- `supabase/tests/deletion.sql` — transactional proofs.
- `supabase/functions/_shared/storage/deletion-service.ts` + `_test.ts`.
- `supabase/functions/cleanup-worker/index.ts`, `handler.ts`, `handler_test.ts`, `deno.json`, `_shared` symlink.
- `scripts/storage-inventory.mjs` — read-only orphan/leak reconciliation.
- `docs/superpowers/specs/2026-09-20-retention-policy.md` — the D2 decision, written down.

**Modified:**
- `supabase/functions/api/app.ts` — `DELETE /generations/:id`, `DELETE /personas/:id`, `deleteAccount`, `/library/import`, `/edits/save`.
- `src/app/features/settings/**` — delete-account copy matching what actually happens.

---

## Task 1: Decide and write down the retention policy (D2)

**Files:**
- Create: `docs/superpowers/specs/2026-09-20-retention-policy.md`

**This task is blocking.** Every later task reads its numbers. Do not guess them; the answers change what the cron deletes and how long a customer can recover.

- [ ] **Step 1: Gather what the product currently promises**

```bash
cd /Users/user/IdeaProjects/vansen && grep -rn "delete\|deletion\|retain\|retention\|30 day\|30-day" src/app/features/settings src/app/features/legal vansen.md --include=*.html --include=*.ts --include=*.md 2>/dev/null | head -40
```

Record every promise found, with its file and line. A policy that contradicts shipped copy is a policy that has to change the copy too.

- [ ] **Step 2: Write the spec with the decisions filled in**

Create `docs/superpowers/specs/2026-09-20-retention-policy.md`:

```markdown
# Retention and Deletion Policy (decision D2)

Written 2026-09-20. Every number here is enforced by `0021_durable_deletion.sql`
and asserted by `supabase/tests/deletion.sql`. Changing a number means changing
both, plus the customer-facing copy listed at the bottom.

## What each deletion actually removes

| Action | Rows | Objects | Ledger | Auth user |
|---|---|---|---|---|
| Delete one generation | the row | media + thumb | kept | kept |
| Delete a persona | tombstone, then remove after training settles | owned photos + ZIP; provider LoRA tracked separately | kept | kept |
| Delete account | requested → processing → completed | owned objects + tracked provider requests, subject to approved evidence retention | **kept, anonymised** | deleted after durable closure |
| Lapse purge (day 31) | generations + personas | their objects | kept | kept |

The ledger survives account deletion because it is financial history: refunds,
chargebacks and tax records need it. It is anonymised — `user_id` is repointed
to null with a non-identifying audit reference — rather than deleted. Say this in the delete-account dialog.

## Retained data decisions

Record exact duration, purpose, access restriction and deletion trigger for financial rows/business idempotency keys, moderation events/quarantine evidence, training photos/ZIPs, diagnostic webhook receipts and provider-hosted LoRA artifacts. A provider deletion request is not proof of removal: record its supported API/contract, acknowledgement and any provider retention limitation. These choices block deletion execution until approved. Apply an approved legal/evidence hold explicitly; never silently treat held evidence as already removed.

## The grace window

- Soft-delete window: **<DECIDE: 0 or N days>**. If 0, a delete is immediate and
  irreversible and the UI must say so without hedging.
- Lapse grace before purge: **<DECIDE: reconcile the 30-day SQL behavior with vansen.md's no-grace promise>** after `current_period_end`. Disk SQL is not evidence of deployed policy.
- Outbox retry budget: **<DECIDE: attempts>** over **<DECIDE: window>**, after
  which a stuck object is alerted on, never silently dropped.

## What "deleted" means to a customer

<DECIDE: the exact sentence shown in the settings dialog. It must be true of
the table above — in particular about the ledger and about the grace window.>

## Copy that must match this policy

<Paste the grep results from Step 1 here, each marked OK or NEEDS-CHANGE.>
```

- [ ] **Step 3: Resolve every `<DECIDE:>` with the user**

Present the open choices with a recommendation each. Do not proceed to Task 2 until no `<DECIDE:` remains:

```bash
cd /Users/user/IdeaProjects/vansen && ! grep -q "<DECIDE:" docs/superpowers/specs/2026-09-20-retention-policy.md && echo "POLICY DECIDED"
```

Expected: `POLICY DECIDED`. User commits.

---

## Task 2: Bucket-aware artifact registry and deletion outbox

**Files:** Create `supabase/migrations/0021_durable_deletion.sql`, `supabase/tests/deletion.sql`; modify P1 upload writers, P4 shared store, P5 training output/ZIP writers. Preserve P1's upload schema: `id,user_id,path,purpose,mime,bytes,width,height,moderation,created_at`. Do not rename it or seed incomplete rows.

**Interfaces:** Store local objects as `{backend,bucket,path}`; provider-hosted artifacts are separate records. An R2 video poster uses the generation's recorded backend/bucket, not a presumed Supabase bucket.

- [ ] **Step 1: Add RED fixtures covering each real artifact kind**

Seed synthetic Supabase `media` and `uploads` objects, an R2 video/poster, persona photos, `persona-zips/`, scratch and quarantine evidence. Give identical paths in two different buckets to expose bucket-blind deletion. Seed external `personas.lora_url` separately; no local delete should ever receive that URL. Insert upload fixtures with all P1 required fields. Record ledger/expense history before deleting.

- [ ] **Step 2: Create durable locators and outbox records**

```sql
create table public.storage_objects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  backend text not null check (backend in ('supabase','r2')),
  bucket text not null,
  path text not null,
  purpose text not null,
  state text not null check (state in ('staged','live','delete_pending','held','gone')),
  retain_until timestamptz,
  created_at timestamptz not null default now(),
  unique (backend,bucket,path)
);
create table public.deletion_outbox (
  id uuid primary key default gen_random_uuid(),
  object_id uuid not null references public.storage_objects(id),
  backend text not null, bucket text not null, object_path text not null,
  reason text not null, not_before timestamptz not null default now(),
  attempts int not null default 0, last_error text,
  lease_token uuid, lease_until timestamptz, completed_at timestamptz,
  unique (backend,bucket,object_path)
);
create table public.provider_artifact_deletions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid, provider text not null, artifact_ref text not null,
  status text not null check (status in ('requested','processing','confirmed','unsupported','failed')),
  evidence_ref text, last_error text, next_run_at timestamptz,
  unique (provider,artifact_ref)
);
```

Enable service-only RLS; audit rows survive profile deletion, with owner anonymized only after closure. Add indexes for due unresolved rows. Insert artifact intent BEFORE each upload; mark live after success. If an upload/DB response is ambiguous its locator remains discoverable. Writers include uploads, save/import, generated media/posters/thumbnails, training ZIPs, scratch and quarantine copies. Do not silently skip a failed registry write and then create untracked bytes.

Backfill locators from exact database references and a read-only inventory. For generations use recorded backend and each artifact's verified bucket; P1 upload paths/photo paths/ZIPs are in Supabase `uploads`. External LoRA URLs stay in the provider table. Unknown legacy backend requires an exact-path probe in both stores; one match resolves it, zero/two matches require review. Persist the resolution and remove all `?? 'r2'`/`?? 'supabase'` ownership guesses from signing, poster writes and deletion.

- [ ] **Step 3: Implement enqueue, claim and completion RPCs**

`fn_enqueue_deletions(p_objects jsonb,p_reason text,p_not_before timestamptz) returns void` receives registry IDs, checks each locator/ownership, marks delete_pending and inserts outbox in the same transaction that hides/removes its source reference. Copy backend/bucket/path from the registry, never from an untrusted caller. Repeated enqueue uses ON CONFLICT and must not postpone an earlier authorized deletion.

`fn_claim_deletions(p_limit int)` uses `FOR UPDATE SKIP LOCKED`, due not_before and expired/no lease; it sets a fresh token/expiry and increments attempts. `fn_complete_deletion(p_id,p_token,p_error)` checks unexpired token; success atomically marks outbox completed and registry gone, failure retains the row with backoff and safe error. Exhaustion alerts and preserves unresolved work.

```sql
update public.deletion_outbox
set completed_at = now(), lease_token = null, lease_until = null
where id = p_id and lease_token = p_token and lease_until > now()
  and completed_at is null
returning object_id;
```

A zero-row completion is a stale claim, not success. Test concurrent claims, stale ack, repeated enqueue and a bucket-specific absent object.

- [ ] **Step 4: Make deletion a lifecycle, including account/lapse paths**

Add `deleted_at` tombstones to generations/personas and an `account_deletions` record with requested/processing/completed, subscription reconciliation state and unresolved counts. Under the SAME user money lock as reservation, mark closure requested and prevent new generation/training/billing creation. Hide content immediately; request P5 cancellation for every pending generation/training job and retain rows until terminal/reconciled.

`fn_delete_generation`, `fn_delete_persona`, `fn_purge_lapsed` and `fn_delete_account` all call this mechanism; none directly cascades away pending work. Finished outputs that arrive during closure go directly to registered cleanup without becoming visible. Cleanup waits for the relevant soft-delete/evidence retention deadline.

Drop the OLD void signature `fn_delete_account(uuid)` BEFORE creating its new JSON-returning signature, in the same migration transaction; restore grants. New response is `{status,requestId,pendingObjects,pendingJobs,providerArtifacts}`, never “complete” with unresolved work. Finalization anonymizes ledger, billing transaction and provider expense ownership (nullable FK as required) and only then deletes profile/auth. Do not delete financial idempotency anchors or provider expense totals.

- [ ] **Step 5: Run the SQL proofs**

```bash
psql "$VANSEN_LOCAL_DB" -X -v ON_ERROR_STOP=1 -f supabase/tests/deletion.sql
```

Assert each expected locator is enqueued with its actual bucket, retained evidence is held with its policy deadline, pending job rows survive until safe finalization, and all paths obey the approved D2 numbers. Inject registry/outbox insert failure: source deletion rolls back rather than losing the locator. User commits.

---

## Task 3: Cleanup service, worker and exact absence checks

**Files:** Create `supabase/functions/_shared/storage/deletion-service.ts`, `deletion-service_test.ts`, `cleanup-worker/{index.ts,handler.ts,handler_test.ts,deno.json}` and `_shared` symlink. Extend `storage/types.ts` with `ObjectRef`.

- [ ] **Step 1: Define the correct object API and RED tests**

```ts
export interface ObjectRef {
  backend: 'supabase' | 'r2';
  bucket: string;
  path: string;
}
export interface DeleteDeps {
  admin: SupabaseClient;
  r2Bucket: string;
  r2: StorageAdapter;
}
export async function deleteObject(deps: DeleteDeps, ref: ObjectRef): Promise<void> {
  if (!ref.bucket || !ref.path) throw new Error('invalid_object_locator');
  if (ref.backend === 'r2' && ref.bucket !== deps.r2Bucket) throw new Error('unknown_r2_bucket');
  if (ref.backend === 'r2') return deps.r2.delete(ref.path);
  const { error } = await deps.admin.storage.from(ref.bucket).remove([ref.path]);
  if (error) throw new Error('object_delete_failed');
}
```

Import existing Supabase/storage types; do not call `storageFor('supabase').delete`, which hardcodes `media`. Test deleting `uploads/a.png` leaves `media/a.png` untouched; R2 bucket mismatch fails; transport/permission error remains unresolved. “Already absent” is accepted only for the EXACT registered backend/bucket/key. A generic substring “404” or wrong bucket is not absence proof.

- [ ] **Step 2: Implement leased retries and verify disappearance**

`drainDeletions(deps,limit)` claims, deletes each exact locator and verifies absence through the backend's supported metadata/existence query before fenced completion. Query errors are errors, not absence. Use checked `fn_complete_deletion`; backoff 1–60 minutes with jitter, approved retry budget and dead-letter alert without discarding work. Keep a request timeout shorter than the lease; expired workers cannot acknowledge another worker's work.

Tests inject delete success but still-present object, lost network response, transient storage error, interrupted batch and stale token. A storage outage returns accepted deletion status to the customer and leaves tracked cleanup pending.

- [ ] **Step 3: Wire worker auth and scheduling**

Worker validates a dedicated cleanup secret before any claim. Configure URL and secret via Supabase Vault in P9, not a database GUC/service-role key. Register `drive_cleanup_worker` with pg_cron/pg_net using the same fail-closed prerequisites as P5. Missing extensions/configuration fail setup or emit an actionable unhealthy scheduler status; they never silently pass a release gate.

- [ ] **Step 4: Verify GREEN**

```bash
cd supabase/functions
deno check cleanup-worker/index.ts
deno test --allow-all _shared/storage/deletion-service_test.ts cleanup-worker
```

User commits.

---

## Task 4: Route every deletion through closure and reconcile subscriptions

**Files:** Modify `api/app.ts`, shared store/dispatch/training writers, cleanup worker and settings account-deletion UI; create `api/deletion_routes_test.ts`.

- [ ] **Step 1: Write route/lifecycle RED cases**

Delete pending generation, in-flight training, ready persona, and an account with both providers' media. Delete twice. Cause a provider output to arrive AFTER deletion requested. Cause cancellation to be unsupported/unreachable. Expect accepted/processing and no resurrection; lifecycle/expense rows remain until reconciliation. Test lapse purge obeys the same rules.

- [ ] **Step 2: Remove inline cancellation and direct deletes**

Routes call the Task 2 RPCs and return requestId/status. They do not set `jobs.state='done'` or invent `FAR_FUTURE`; only the current worker lease can settle. Worker cancellation selects `adapterFor(generation.family_id)`, never `adapterFor(job.provider)`. A provider with no cancellation may finish; capture and delete its late output through the registry. Replace raw SQL deletes in lapse/account paths with requests to this same lifecycle.

- [ ] **Step 3: Reconcile every subscription before claiming account closure**

Persist verified Stripe subscription IDs/status and Apple original transaction ID in the closure record before removing profile/auth. Handle active, trialing, past_due, unpaid, incomplete, paused, canceled and incomplete_expired explicitly: fetch authoritative state; stop future collection where the provider permits it; record already-final subscriptions; retry operational failures. Do not restrict cleanup to the existing `status='active'` branch.

Apple server verification does not imply the app can cancel a user's store subscription. Record original transaction entitlement/revocation and surface the supported manage-subscription action and any required user action. Future notifications resolve to the closure tombstone, cannot recreate an entitlement or orphan paid grants. Unresolved billing/provider deletion is reported honestly, not silently “complete”. Test each status and late webhook.

- [ ] **Step 4: Align settings and policy copy**

Update `vansen.md` retention paragraph (currently “no grace period”), settings, privacy/help text and lapse warnings to the approved D2 decision. Say when deletion is requested, processing or completed; explain retained anonymized financial/evidence records and provider-hosted limitations using the approved durations. Preserve page composition.

Run `deno test --allow-all api/deletion_routes_test.ts _shared/jobs cleanup-worker` and relevant Angular settings tests. User commits.

---

## Task 5: Prove removal with a complete read-only inventory

**Files:** Create `scripts/storage-inventory.mjs`, `scripts/storage-inventory.test.mjs`, `docs/superpowers/plans/2026-09-20-deletion-verification-log.md`.

- [ ] **Step 1: Implement paginated inventory of every configured store**

Use `storage_objects` and unresolved deletion rows as the expected locators, and cross-check source rows (`uploads.path`, generation media/thumb, persona photos/ZIPs) against that registry. Key by all three fields:

```js
export const objectKey = ({ backend, bucket, path }) => JSON.stringify([backend, bucket, path]);
```

Page database tables with stable ID order; page EACH Supabase folder with limit/offset and recursive traversal. Inventory both `media` and `uploads`. Page R2 with its continuation token and exact configured bucket. Compare live, staged, queued, held and gone objects separately; don't count a queued object's existence as an untracked orphan. Report provider-hosted deletion separately with evidence/limitations.

Exit nonzero for any unreadable/unconfigured required backend or incomplete page. A partial inventory cannot report a clean result. The script is read-only, never a prefix-deletion tool.

- [ ] **Step 2: Add retained reconciler tests**

Synthetic stores contain >1000 objects in one folder and >1000 personas/queue rows; both buckets contain the same key. Assert complete enumeration, correct cross-store distinction, error propagation and exact orphan/missing counts. Remove page two access and assert nonzero. Run `node --test scripts/storage-inventory.test.mjs`.

- [ ] **Step 3: Rehearse and record every deletion path**

Record before/after inventory for image, R2 video/poster, upload, persona photos/ZIP/LoRA, scratch/quarantine, whole account, lapse, repeated request, failed backend, stale lease, worker restart and late output. Distinguish confirmed local removal, approved held evidence and provider-hosted pending/unsupported deletion. Capture balances/expense totals to prove retention and no double refund. No blanket “everything gone” result when provider evidence is unavailable.

- [ ] **Step 4: Verify the complete plan**

```bash
npm test -- --watch=false
node --test scripts/storage-inventory.test.mjs
psql "$VANSEN_LOCAL_DB" -X -v ON_ERROR_STOP=1 -f supabase/tests/deletion.sql
```

Run edge suites for `_shared api job-worker cleanup-worker`. Use only disposable/local data until P9 authorizes production rollout; production cleanup needs its concrete dry-run scope. User commits.

---

## Exit criteria for P6

- [ ] Every object has a verified backend/bucket/path, including uploads, ZIPs, posters and quarantine.
- [ ] Every delete path hides content, safely settles/reconciles pending work, and durably schedules cleanup before dropping ownership.
- [ ] A failed backend or stale lease never reports completed removal; repeated deletion is idempotent.
- [ ] Financial/expense history and approved evidence retention survive account closure as specified by D2.
- [ ] Provider LoRA deletion and subscription limitations are explicit and tracked.
- [ ] Full inventory covers Supabase and R2 with all pages; incomplete access fails verification.
- [ ] D2 policy, settings/privacy/help and vansen.md state the same lifecycle and durations.
- [ ] Worker remains undeployed until P9; local proof is not production proof.
