import * as ort from 'onnxruntime-web';
import { WritableSignal } from '@angular/core';

/**
 * Shared ONNX model plumbing for every in-browser engine (heal, cut-out,
 * bokeh, upscale, smart select): download once with progress, keep in Cache
 * Storage, create an ort session on WebGPU when available, wasm otherwise.
 * Only ever imported from lazily-loaded engine modules — never eagerly.
 */

const MODEL_CACHE = 'vansen-models';

export type OrtProviders = Array<'webgpu' | 'wasm'>;

const sessions = new Map<string, Promise<ort.InferenceSession>>();

export function getOrtSession(
  url: string,
  progress: WritableSignal<number | null>,
  providers?: OrtProviders,
): Promise<ort.InferenceSession> {
  // Sessions are cached per (providers, url) — an engine can hold both a GPU
  // and a CPU session of the same model (upscale falls back at runtime).
  const key = `${providers?.join('+') ?? 'auto'}|${url}`;
  // A failed init forgets itself so the next attempt can retry (e.g. back online).
  let p = sessions.get(key);
  if (!p) {
    p = createSession(url, progress, providers).catch((e: unknown) => {
      sessions.delete(key);
      throw e;
    });
    sessions.set(key, p);
  }
  return p;
}

async function createSession(
  url: string,
  progress: WritableSignal<number | null>,
  providers?: OrtProviders,
): Promise<ort.InferenceSession> {
  ort.env.wasm.wasmPaths = '/assets/ort/';
  const model = await loadModelBytes(url, progress);
  const eps: OrtProviders =
    providers ?? ('gpu' in navigator ? ['webgpu', 'wasm'] : ['wasm']);
  return ort.InferenceSession.create(model, { executionProviders: eps });
}

/** Model bytes from Cache Storage, else network (with download progress). */
export async function loadModelBytes(
  url: string,
  progress: WritableSignal<number | null>,
): Promise<Uint8Array> {
  const cache = typeof caches === 'undefined' ? null : await caches.open(MODEL_CACHE);
  const hit = await cache?.match(url);
  if (hit) return new Uint8Array(await hit.arrayBuffer());

  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`model fetch failed: ${res.status}`);
  const total = Number(res.headers.get('Content-Length')) || 0;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  progress.set(0);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      if (total) progress.set(got / total);
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
  try {
    await cache?.put(url, new Response(bytes.slice()));
  } catch {
    // Quota/private-mode — still works this session, just re-downloads next time.
  }
  return bytes;
}
