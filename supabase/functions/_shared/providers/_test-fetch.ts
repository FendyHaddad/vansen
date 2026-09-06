export type FetchHandler = (url: string, init?: RequestInit) => Response | Promise<Response>;

/** Replace globalThis.fetch for one test. Returns restore fn. */
export function stubFetch(handler: FetchHandler): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(String(input instanceof Request ? input.url : input), init))) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
