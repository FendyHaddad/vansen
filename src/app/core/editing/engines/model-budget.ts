/**
 * A ceiling on how much of the customer's device the editor's model weights
 * may occupy, and least-recently-used eviction to stay under it.
 *
 * Browsers grant far more than this, but a photo editor quietly holding a
 * third of a gigabyte of ONNX files is not a reasonable default — and on a
 * device with a 500 MB quota it is the difference between the app working and
 * every other cache being evicted out from under it.
 */
import { MODEL_CACHE } from './model-cache-name';

/**
 * Deliberately above `TOTAL_MANIFEST_BYTES` (~257 MB) with headroom: a budget
 * below the manifest total would make a customer who uses every Pro tool
 * re-download models forever, trading egress for a number that looks tidy.
 */
export const MODEL_CACHE_BUDGET_BYTES = 320_000_000;

const USAGE_KEY = 'vansen.models.usage';

interface Usage {
  /** url -> { bytes, last used (epoch ms) } */
  [url: string]: { bytes: number; usedAt: number };
}

function readUsage(): Usage {
  try {
    return JSON.parse(localStorage.getItem(USAGE_KEY) ?? '{}') as Usage;
  } catch {
    return {};
  }
}

function writeUsage(usage: Usage): void {
  try {
    localStorage.setItem(USAGE_KEY, JSON.stringify(usage));
  } catch {
    // Private mode or a full quota. The budget then degrades to "whatever the
    // browser evicts", which is the behaviour we had before this existed.
  }
}

/** Urls whose ONNX session is live right now; never evict these. */
const pinned = new Set<string>();

export function pinModel(url: string): void {
  pinned.add(url);
}

export function unpinModel(url: string): void {
  pinned.delete(url);
}

export function cachedBytes(): number {
  return Object.values(readUsage()).reduce((sum, e) => sum + e.bytes, 0);
}

/** Records a model as freshly used, so eviction reaches for it last. */
export function touchModel(url: string, bytes: number): void {
  const usage = readUsage();
  usage[url] = { bytes, usedAt: Date.now() };
  writeUsage(usage);
}

/**
 * Makes room for `bytes`, evicting least-recently-used entries first.
 *
 * Never throws: a cache that will not evict is a reason to skip the write,
 * not a reason to fail the download the customer is waiting on.
 */
export async function reserveBudget(bytes: number): Promise<boolean> {
  if (bytes >= MODEL_CACHE_BUDGET_BYTES) return false;
  const usage = readUsage();
  let total = Object.values(usage).reduce((sum, e) => sum + e.bytes, 0);
  if (total + bytes <= MODEL_CACHE_BUDGET_BYTES) return true;

  const candidates = Object.entries(usage)
    .filter(([url]) => !pinned.has(url))
    .sort((a, b) => a[1].usedAt - b[1].usedAt);

  for (const [url, entry] of candidates) {
    if (total + bytes <= MODEL_CACHE_BUDGET_BYTES) break;
    const dropped = await dropFromCache(url);
    if (!dropped) continue;
    delete usage[url];
    total -= entry.bytes;
  }
  writeUsage(usage);
  return total + bytes <= MODEL_CACHE_BUDGET_BYTES;
}

async function dropFromCache(url: string): Promise<boolean> {
  if (typeof caches === 'undefined') return true;
  try {
    const cache = await caches.open(MODEL_CACHE);
    await cache.delete(url);
    return true;
  } catch {
    return false;
  }
}

/** Sign-out and tests: forget every recorded model. */
export function forgetUsage(): void {
  try {
    localStorage.removeItem(USAGE_KEY);
  } catch {
    // ignore
  }
  pinned.clear();
}
