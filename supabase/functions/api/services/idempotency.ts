// A submission is identified by (user, idempotency key, body hash).
//
// Without this, a request that timed out on the client was indistinguishable
// from a new one: the retry charged again and ran the model again. The body
// hash is what makes the key safe — reusing a key with a DIFFERENT body is a
// client bug, and answering it with the first result would silently give the
// customer something they did not ask for.
import type { Context } from 'jsr:@hono/hono';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A client-supplied key, or null when it did not send a usable one. */
export function readIdempotencyKey(c: Context): string | null {
  const raw = c.req.header('idempotency-key') ?? '';
  return UUID.test(raw) ? raw.toLowerCase() : null;
}

/** Stable JSON: sorted object keys, arrays left alone, undefined dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export async function bodyHash(payload: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(payload));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
