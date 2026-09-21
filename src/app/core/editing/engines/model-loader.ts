import * as ort from 'onnxruntime-web';
import { WritableSignal } from '@angular/core';
import { MODEL_CACHE } from './model-cache-name';
import { pinModel, reserveBudget, touchModel, unpinModel } from './model-budget';
import { askModelConsent } from './model-consent';
import type { ModelEntry, ModelId } from './model-manifest';
import { modelFor } from './model-manifest';

/**
 * Shared ONNX model plumbing for every in-browser engine (heal, cut-out,
 * bokeh, upscale, smart select, sharpen): download once with progress and an
 * integrity check, keep in Cache Storage under a budget, create an ort
 * session on WebGPU when available, wasm otherwise.
 * Only ever imported from lazily-loaded engine modules — never eagerly.
 */

export type OrtProviders = Array<'webgpu' | 'wasm'>;

/** What a caller holds while it is using a model. */
export interface SessionLease {
  session: ort.InferenceSession;
  /** Idempotent. The last owner to let go disposes the session. */
  release(): Promise<void>;
}

interface LiveSession {
  promise: Promise<ort.InferenceSession>;
  owners: number;
}

const sessions = new Map<string, LiveSession>();

/**
 * Test seam. ONNX sessions cannot be created in a unit test, and mocking a
 * relative import is not supported by the Angular vitest system, so the
 * factory is replaceable here instead.
 */
export type SessionFactory = (
  entry: ModelEntry,
  progress: WritableSignal<number | null>,
  providers?: OrtProviders,
) => Promise<ort.InferenceSession>;

let factory: SessionFactory = createSession;

export function setOrtSessionFactory(next: SessionFactory | null): void {
  factory = next ?? createSession;
}

/** Live session count, for tests that check nothing is left behind. */
export function liveSessionCount(): number {
  return sessions.size;
}

/**
 * Borrow a model for one operation.
 *
 * Sessions used to be created once and kept for the life of the tab: seven
 * tools meant up to seven ONNX runtimes resident, each holding its weights,
 * on a device that may have a gigabyte for everything. An owner count means
 * concurrent users of one model still share it, and the last one out frees
 * it.
 */
export async function acquireOrtSession(
  id: ModelId,
  progress: WritableSignal<number | null>,
  providers?: OrtProviders,
): Promise<SessionLease> {
  const entry = modelFor(id);
  // Keyed on model identity plus execution providers — an engine can hold
  // both a GPU and a CPU session of the same model (upscale falls back).
  const key = `${providers?.join('+') ?? 'auto'}|${id}`;

  let live = sessions.get(key);
  if (!live) {
    live = { promise: factory(entry, progress, providers), owners: 0 };
    sessions.set(key, live);
  }
  live.owners += 1;

  let session: ort.InferenceSession;
  try {
    session = await live.promise;
  } catch (e) {
    // A failed init forgets itself so the next attempt can retry (e.g. back
    // online) rather than being handed the same rejection forever.
    live.owners -= 1;
    if (sessions.get(key) === live) sessions.delete(key);
    throw e;
  }
  pinModel(entry.url);

  let released = false;
  return {
    session,
    release: async () => {
      if (released) return;
      released = true;
      live.owners -= 1;
      if (live.owners > 0) return;
      if (sessions.get(key) === live) sessions.delete(key);
      unpinModel(entry.url);
      await Promise.resolve(session.release?.()).catch(() => undefined);
    },
  };
}

async function createSession(
  entry: ModelEntry,
  progress: WritableSignal<number | null>,
  providers?: OrtProviders,
): Promise<ort.InferenceSession> {
  ort.env.wasm.wasmPaths = '/assets/ort/';
  const model = await loadModelBytes(entry, progress);
  const eps: OrtProviders = providers ?? ('gpu' in navigator ? ['webgpu', 'wasm'] : ['wasm']);
  return await ort.InferenceSession.create(model, { executionProviders: eps });
}

/**
 * Model bytes from Cache Storage, else network, verified either way.
 *
 * A cached copy is verified too: if a poisoned entry were trusted because it
 * is cached, the integrity check would run exactly once and never again.
 */
export async function loadModelBytes(
  entry: ModelEntry,
  progress: WritableSignal<number | null>,
): Promise<Uint8Array> {
  const cache = typeof caches === 'undefined'
    ? null
    : await caches.open(MODEL_CACHE).catch(() => null);
  const hit = await cache?.match(entry.url).catch(() => undefined);
  const cached = hit ? new Uint8Array(await hit.arrayBuffer()) : null;
  if (cached && (await verify(cached, entry))) {
    touchModel(entry.url, entry.bytes);
    return cached;
  }
  // A cached copy that does not verify is poison: drop it before anything
  // else, so a failed download later cannot fall back onto it.
  if (cached) await cache?.delete(entry.url).catch(() => false);

  // Nothing is cached, so this will cost the customer a real download.
  if (!(await askModelConsent(entry))) {
    throw new Error(`model download declined: ${entry.url}`);
  }

  const bytes = await download(entry, progress);
  if (!(await verify(bytes, entry))) {
    throw new Error(`model integrity check failed: ${entry.url}`);
  }

  const room = await reserveBudget(entry.bytes);
  if (room) {
    try {
      await cache?.put(entry.url, new Response(bytes.slice() as BodyInit));
      touchModel(entry.url, entry.bytes);
    } catch {
      // Quota or private mode — works this session, re-downloads next time.
    }
  }
  return bytes;
}

async function download(
  entry: ModelEntry,
  progress: WritableSignal<number | null>,
): Promise<Uint8Array> {
  const res = await fetch(entry.url);
  if (!res.ok || !res.body) throw new Error(`model fetch failed: ${res.status}`);

  // Refuse on the header before buffering, so a wrong or hostile response
  // cannot make us allocate gigabytes.
  const declared = Number(res.headers.get('Content-Length')) || 0;
  if (declared && declared !== entry.bytes) {
    throw new Error(`model size mismatch: expected ${entry.bytes}, got ${declared}`);
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  progress.set(0);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      // No Content-Length to check against: the running total is the only
      // thing standing between us and an endless body.
      if (got > entry.bytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`model size mismatch: body exceeds ${entry.bytes} bytes`);
      }
      chunks.push(value);
      progress.set(got / entry.bytes);
    }
  } finally {
    progress.set(null);
  }

  const bytes = new Uint8Array(got);
  let off = 0;
  for (const c of chunks) {
    bytes.set(c, off);
    off += c.length;
  }
  return bytes;
}

async function verify(bytes: Uint8Array, entry: ModelEntry): Promise<boolean> {
  if (bytes.length !== entry.bytes) return false;
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return hex === entry.sha256;
}
