// Everything that happens between "the provider says it is finished" and
// "the customer can open the file".
//
// It lives here, not in the gateway, because P5's dispatcher has to run the
// exact same finalizer: two implementations of "store then settle" is how the
// original defect (upload error ignored, `done` written anyway) survived in
// four places at once.
//
// The invariants, in order:
//   1. Nothing is read into memory before its declared size and type are
//      checked — `StorageAdapter.put` takes bytes, because R2's S3 PutObject
//      rejects the chunked encoding fetch uses for a streaming body.
//   2. The object exists before any row says `done`.
//   3. Each attempt writes its OWN key, so a slow loser can never overwrite
//      the winner's object.
//   4. A settlement whose outcome is unknown is not a lost race: the object
//      stays for reconciliation.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { type CheckResult, isUrlResult } from '../providers/types.ts';
import {
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
  type StorageAdapter,
  type StorageBackend,
  VIDEO_CONTENT_TYPES,
} from '../storage/index.ts';
import { settleDone, settleFailed } from './settlement.ts';

export { MAX_IMAGE_BYTES, MAX_VIDEO_BYTES, VIDEO_CONTENT_TYPES };

/** How many times a download/store may be retried before the job is failed. */
export const MAX_STORE_ATTEMPTS = 3;

export const IMAGE_CONTENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
]);

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

const VIDEO_EXTENSIONS: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
};

export type MediaKind = 'image' | 'video';

export interface FinishJob {
  id: string;
  user_id: string;
  generation_id: string;
  attempts?: number;
  lease_token?: string;
}

export interface FinishDeps {
  admin: SupabaseClient;
  storageFor: (backend: StorageBackend) => StorageAdapter;
  fetch?: typeof fetch;
}

interface Budget {
  kind: MediaKind;
  backend: StorageBackend;
  types: Set<string>;
  maxBytes: number;
  extensions: Record<string, string>;
}

const BUDGETS: Record<MediaKind, Budget> = {
  image: {
    kind: 'image',
    backend: 'supabase',
    types: IMAGE_CONTENT_TYPES,
    maxBytes: MAX_IMAGE_BYTES,
    extensions: IMAGE_EXTENSIONS,
  },
  video: {
    kind: 'video',
    backend: 'r2',
    types: VIDEO_CONTENT_TYPES,
    maxBytes: MAX_VIDEO_BYTES,
    extensions: VIDEO_EXTENSIONS,
  },
};

export async function finishJob(
  deps: FinishDeps,
  job: FinishJob,
  result: CheckResult,
): Promise<void> {
  if (result.state === 'running') return await recordProgress(deps, job, result);
  if (result.state === 'retryable_failure') return await touchJob(deps, job);
  if (result.state === 'failed') return await failJob(deps, job, result.error);
  if (isUrlResult(result)) return await storeUrlResult(deps, job, result);
  await storeInlineResult(deps, job, result);
}

// ---------------------------------------------------------------- non-terminal

async function recordProgress(
  deps: FinishDeps,
  job: FinishJob,
  result: Extract<CheckResult, { state: 'running' }>,
): Promise<void> {
  await deps.admin
    .from('jobs')
    .update({
      ...(result.progress != null ? { progress: result.progress } : {}),
      ...(result.queuePosition != null ? { queue_position: result.queuePosition } : {}),
      phase: result.phase ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', job.id);
}

/**
 * The provider is briefly unavailable — a 429, a 502, a dropped connection.
 * The job is still running and will still bill us, so it stays pending and
 * gets polled again. `error` is deliberately NOT written: jobs_pending_idx is
 * `where error is null`, so recording a transient failure there would drop the
 * job out of the pending sweep entirely.
 */
async function touchJob(deps: FinishDeps, job: FinishJob): Promise<void> {
  await deps.admin
    .from('jobs')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', job.id);
}

async function failJob(
  deps: FinishDeps,
  job: FinishJob,
  error: string,
): Promise<void> {
  // The notification is queued by fn_settle_job in the same transaction; the
  // outbox drainer delivers it. Nothing is pushed from here.
  await settleFailed(deps.admin, job.id, error, { leaseToken: job.lease_token });
}

// -------------------------------------------------------------------- storing

async function storeInlineResult(
  deps: FinishDeps,
  job: FinishJob,
  result: Extract<CheckResult, { bytes: Uint8Array }>,
): Promise<void> {
  const budget = await budgetFor(deps, job);
  // An unreadable generation row says nothing about the job. Settling on a
  // guess would either refund a job that succeeded or mark a video done in the
  // image bucket; the next poll retries.
  if (!budget) return;

  const contentType = normalizeType(result.contentType, 'image/png');
  const rejection = rejectPayload(budget, contentType, result.bytes.byteLength);
  if (rejection) {
    console.error('media_rejected', job.generation_id, rejection);
    await failJob(deps, job, 'store_failed');
    return;
  }

  const key = mediaKey(job, budget, contentType);
  const stored = await putObject(deps, budget, key, result.bytes, contentType);
  if (!stored) {
    // No object, no `done`. The refund is the honest outcome: the customer
    // paid for a file we could not keep.
    await failJob(deps, job, 'store_failed');
    return;
  }
  await settleStored(deps, job, budget, key, {});
}

async function storeUrlResult(
  deps: FinishDeps,
  job: FinishJob,
  result: Extract<CheckResult, { url: string }>,
): Promise<void> {
  // Claim: only one poller downloads the file. No row back (and no error)
  // means someone else already has it.
  const { data: claimed, error: claimError } = await deps.admin
    .from('jobs')
    .update({ claimed_at: new Date().toISOString(), phase: 'saving' })
    .eq('id', job.id)
    .is('claimed_at', null)
    .select('id');
  if (claimError) {
    console.error('[finishJob] claim failed', job.id, claimError.message);
    return;
  }
  if (!claimed || claimed.length === 0) return;

  const budget = await budgetFor(deps, job);
  if (!budget) return await releaseClaim(deps, job);

  let key: string;
  try {
    const { bytes, contentType } = await downloadBounded(result.url, {
      headers: result.headers,
      fallbackContentType: result.contentType,
      allowedTypes: budget.types,
      maxBytes: budget.maxBytes,
      label: budget.kind,
      fetchImpl: deps.fetch,
    });
    key = mediaKey(job, budget, contentType);
    const stored = await putObject(deps, budget, key, bytes, contentType);
    if (!stored) throw new Error('storage write failed');
  } catch (e) {
    await retryOrFail(deps, job, e);
    return;
  }

  const meta = {
    durationS: result.durationS,
    width: result.width,
    height: result.height,
  };
  const outcome = await settleStored(deps, job, budget, key, meta);
  if (outcome !== 'unknown') return;
  await releaseClaim(deps, job);
}

async function retryOrFail(
  deps: FinishDeps,
  job: FinishJob,
  cause: unknown,
): Promise<void> {
  const attempts = (job.attempts ?? 0) + 1;
  console.error('store_failed', job.id, attempts, cause);
  if (attempts >= MAX_STORE_ATTEMPTS) {
    await failJob(deps, job, 'store_failed');
    return;
  }
  await deps.admin
    .from('jobs')
    .update({ claimed_at: null, phase: 'rendering', attempts })
    .eq('id', job.id);
}

async function releaseClaim(deps: FinishDeps, job: FinishJob): Promise<void> {
  await deps.admin
    .from('jobs')
    .update({ claimed_at: null, phase: 'rendering' })
    .eq('id', job.id);
}

type StoreOutcome = 'done' | 'lost' | 'unknown';

async function settleStored(
  deps: FinishDeps,
  job: FinishJob,
  budget: Budget,
  key: string,
  meta: Record<string, unknown>,
): Promise<StoreOutcome> {
  let outcome;
  try {
    outcome = await settleDone(
      deps.admin,
      job.id,
      { path: key, backend: budget.backend, meta },
      { leaseToken: job.lease_token },
    );
  } catch (e) {
    // UNKNOWN is not the same as losing. Keep the object: a `done` row may
    // already point at it, and deleting it here would throw away the only
    // copy of something the customer paid for.
    console.error('[finishJob] settlement failed', job.generation_id, e);
    return 'unknown';
  }
  if (!outcome.settled) {
    // A cancel, the stale sweep or another attempt got there first. Their
    // decision stands; this object is an orphan.
    await dropLostObject(deps, job.generation_id, key, budget.backend);
    return 'lost';
  }
  return 'done';
}

/**
 * Only an object this attempt wrote may be removed, and only once a successful
 * read proves the surviving row points somewhere else. A failed read, or a row
 * that names this very key, means keep it.
 */
export async function dropLostObject(
  deps: FinishDeps,
  generationId: string,
  key: string,
  backend: StorageBackend,
): Promise<void> {
  const { data: row, error } = await deps.admin
    .from('generations')
    .select('status,media_path')
    .eq('id', generationId)
    .maybeSingle();
  if (error) {
    console.error('[finishJob] orphan check failed, keeping object', key, error.message);
    return;
  }
  if (row?.media_path === key) return;
  console.warn('[finishJob] generation already settled, dropping object', generationId);
  await deleteObject(deps, backend, key);
}

async function deleteObject(
  deps: FinishDeps,
  backend: StorageBackend,
  key: string,
): Promise<void> {
  if (backend !== 'supabase') {
    // P6 turns a failed delete into a durable cleanup job; for now it has to
    // at least be findable in the logs.
    await deps.storageFor(backend).delete(key).catch((e) =>
      console.error('orphan_delete_failed', key, String(e))
    );
    return;
  }
  const { error } = await deps.admin.storage.from('media').remove([key]);
  if (!error) return;
  console.error('orphan_delete_failed', key, error.message);
}

async function putObject(
  deps: FinishDeps,
  budget: Budget,
  key: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<boolean> {
  if (budget.backend !== 'supabase') {
    await deps.storageFor(budget.backend).put(key, bytes, contentType);
    return true;
  }
  // Images stay on the service-role client: it is the same connection the rest
  // of the gateway uses, and `upsert` is never needed because the key is
  // unique per attempt.
  const { error } = await deps.admin.storage
    .from('media')
    .upload(key, bytes, { contentType, upsert: true });
  if (!error) return true;
  console.error('media_upload_failed', key, error.message);
  return false;
}

// ------------------------------------------------------------------- policies

async function budgetFor(
  deps: FinishDeps,
  job: FinishJob,
): Promise<Budget | null> {
  const { data, error } = await deps.admin
    .from('generations')
    .select('kind')
    .eq('id', job.generation_id)
    .maybeSingle();
  if (error || !data) {
    console.error('[finishJob] could not read generation kind', job.generation_id);
    return null;
  }
  return data.kind === 'video' ? BUDGETS.video : BUDGETS.image;
}

function rejectPayload(
  budget: Budget,
  contentType: string,
  byteLength: number,
): string | null {
  if (!budget.types.has(contentType)) {
    return `unexpected ${budget.kind} content type ${contentType}`;
  }
  if (byteLength === 0) return `${budget.kind} payload was empty`;
  if (byteLength > budget.maxBytes) {
    return `${budget.kind} too large: ${byteLength} bytes`;
  }
  return null;
}

/**
 * A key no other attempt can be holding. Overwriting a shared key is how a
 * slow loser replaced the winner's bytes while the winner's row still said
 * `done`.
 */
function mediaKey(job: FinishJob, budget: Budget, contentType: string): string {
  const ext = budget.extensions[contentType] ?? 'bin';
  const attempt = job.attempts ?? 0;
  if (budget.kind === 'video') {
    return `videos/${job.user_id}/${job.generation_id}-${attempt}.${ext}`;
  }
  return `${job.user_id}/${job.generation_id}-${attempt}.${ext}`;
}

function normalizeType(value: string | undefined, fallback: string): string {
  return (value ?? fallback).split(';')[0].trim();
}

// -------------------------------------------------------- bounded downloading

export interface BoundedDownload {
  bytes: Uint8Array;
  contentType: string;
}

export interface BoundedOptions {
  headers?: Record<string, string>;
  /** Used when the response carries no content-type of its own. */
  fallbackContentType?: string;
  /** When set, the declared type must be one of these. */
  allowedTypes?: Set<string>;
  maxBytes: number;
  /** What to call this in error messages. */
  label?: string;
  fetchImpl?: typeof fetch;
}

/** Read a response body with a hard ceiling, verifying what it claims to be. */
export async function downloadBounded(
  url: string,
  opts: BoundedOptions,
): Promise<BoundedDownload> {
  const label = opts.label ?? 'file';
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(url, { headers: opts.headers });
  if (!res.ok || !res.body) throw new Error(`${label} fetch ${res.status}`);

  // Check what the provider SAYS it is sending before reading any of it.
  const declaredType = normalizeType(
    res.headers.get('content-type') ?? opts.fallbackContentType,
    'application/octet-stream',
  );
  if (opts.allowedTypes && !opts.allowedTypes.has(declaredType)) {
    await res.body.cancel().catch(() => undefined);
    throw new Error(`unexpected ${label} content type ${declaredType}`);
  }
  const declaredLength = Number(res.headers.get('content-length') ?? 0);
  if (declaredLength > opts.maxBytes) {
    await res.body.cancel().catch(() => undefined);
    throw new Error(`${label} too large: ${declaredLength} bytes`);
  }

  // Peak allocation, not file size, is what the runtime kills us for. With a
  // content-length we allocate the destination once and copy into it, so the
  // peak IS the file. Without one we have to accumulate chunks and then
  // concatenate, so the peak is twice the file — hence the halved budget.
  const bytes = declaredLength > 0
    ? await readExact(res.body, declaredLength, label)
    : await readBounded(res.body, Math.floor(opts.maxBytes / 2), label);
  if (bytes.byteLength === 0) throw new Error(`${label} download was empty`);
  return { bytes, contentType: declaredType };
}

/**
 * The provider declared a length: allocate exactly that and refuse anything
 * that does not fill it. A body that disagrees with its own content-length was
 * cut short, and storing it would produce a playable-looking corrupt file.
 */
async function readExact(
  body: ReadableStream<Uint8Array>,
  length: number,
  label: string,
): Promise<Uint8Array> {
  const bytes = new Uint8Array(length);
  const reader = body.getReader();
  let observed = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (observed + value.byteLength > length) {
        throw new Error(`${label} exceeds byte budget`);
      }
      bytes.set(value, observed);
      observed += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (observed !== length) throw new Error(`truncated ${label}`);
  return bytes;
}

async function readBounded(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  label: string,
): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let observed = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      observed += value.byteLength;
      // A missing or lying content-length is exactly the case the ceiling is
      // for, so it is enforced again on what actually arrives.
      if (observed > maxBytes) throw new Error(`${label} exceeds byte budget`);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(observed);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
