import { supabase } from '../supabase/supabase-client';

const PREFIX = 'vansen.cache.';

interface Envelope<T> {
  at: number;
  value: T;
}

/**
 * Tiny localStorage snapshot cache: stores boot from the last known server
 * state instantly, then revalidate over the network only when the data can
 * actually change. Best-effort — every failure degrades to "no cache".
 */
export function readCache<T>(key: string, maxAgeMs = Infinity): T | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const env = JSON.parse(raw) as Envelope<T>;
    if (Date.now() - env.at > maxAgeMs) return null;
    return env.value;
  } catch {
    return null;
  }
}

export function writeCache(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify({ at: Date.now(), value }));
  } catch {
    // quota exceeded / private mode — cache is best-effort
  }
}

export function removeCache(key: string): void {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    // ignore
  }
}

/** Sign-out: drop every snapshot so nothing lingers on shared machines. */
export function clearAllCaches(): void {
  try {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith(PREFIX)) localStorage.removeItem(k);
    }
  } catch {
    // ignore
  }
}

/** Per-user cache scoping — a different login on this browser never sees another user's snapshot. */
export async function currentUid(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  return data.session?.user.id ?? 'anon';
}
