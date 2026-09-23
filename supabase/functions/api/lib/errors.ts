// Fire-and-forget error logging into app_errors.
// createErrorLog(admin) returns logError(c, code, err). ErrCtx is the slice
// of a Hono context it reads. Monitoring must never break a request, and it
// never records request bodies or headers.
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

export type ErrCtx = {
  req: { url: string; method: string };
  get: (k: "userId" | "requestId") => string | undefined;
};

export function createErrorLog(admin: SupabaseClient) {
  /** Fire-and-forget write to app_errors — monitoring must never break a request.
   * Never log request bodies or headers here: prompts are user content, headers
   * carry tokens. Message + stack only. */
  function logError(c: ErrCtx, code: string, err: unknown): void {
    const e = err instanceof Error ? err : new Error(String(err));
    admin
      .from("app_errors")
      .insert({
        source: "api",
        route: new URL(c.req.url).pathname,
        method: c.req.method,
        code,
        message: (e.message || "unknown").slice(0, 1000),
        stack: (e.stack ?? "").slice(0, 4000),
        user_id: c.get("userId") ?? null,
        request_id: c.get("requestId") ?? null,
      })
      .then(({ error }) => {
        if (error) console.error("app_errors insert failed:", error.message);
      });
  }
  return logError;
}

export type LogError = ReturnType<typeof createErrorLog>;
