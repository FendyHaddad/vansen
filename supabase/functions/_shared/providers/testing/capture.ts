// Adapter contract tests assert on the request that LEAVES the process. This
// swaps globalThis.fetch for a recorder that answers with a canned provider
// response, so a test can prove "the 4K selection reached the wire" without a
// network, a key, or a bill.
export interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  jsonBody: Record<string, unknown> | null;
  formBody: Map<string, string | { name: string; type: string; size: number }> | null;
}

export interface CaptureHandle {
  calls: Captured[];
  restore(): void;
}

function formEntries(body: FormData): Captured['formBody'] {
  return new Map(
    [...body.entries()].map((
      [k, v],
    ) => [k, typeof v === 'string' ? v : { name: v.name, type: v.type, size: v.size }]),
  );
}

export function captureFetch(respond: (call: Captured) => Response): CaptureHandle {
  const original = globalThis.fetch;
  const calls: Captured[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? {}).forEach((v, k) => {
      headers[k] = k.toLowerCase() === 'authorization' ? '<redacted>' : v;
    });
    const jsonBody = typeof init?.body === 'string'
      ? JSON.parse(init.body) as Record<string, unknown>
      : null;
    const formBody = init?.body instanceof FormData ? formEntries(init.body) : null;
    const call: Captured = { url, method: init?.method ?? 'GET', headers, jsonBody, formBody };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

/** A 1×1 PNG, base64, for canned provider responses. */
export const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
