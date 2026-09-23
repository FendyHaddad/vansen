// Small request/response helpers every route uses.
// fail() is the one error shape (a 5xx also carries the request id as
// errorId); clientOf() reads the x-vansen-client platform header;
// sanitizeLabel() cleans short free text; deletionStatus() is the body of
// every delete that hides content now and queues its bytes.

export function fail(
  c: {
    json: (b: unknown, s: number) => Response;
    get?: (k: "requestId") => string | undefined;
  },
  status: number,
  code: string,
  message: string,
) {
  // A 4xx is the caller's to fix and reads as plain advice. Attaching an
  // incident id to "that file is too large" would suggest we think something
  // broke, and train people to quote ids that lead nowhere useful.
  if (status < 500) return c.json({ error: { code, message } }, status);
  // A 5xx is ours. The id is the whole support conversation: it matches the
  // x-request-id header and the app_errors row for this exact request.
  const errorId = c.get?.("requestId") ?? "";
  return c.json({ error: { code, message, errorId } }, status);
}

const KNOWN_CLIENTS = new Set(["web", "ios", "android"]);

/** Platform marker from the x-vansen-client header; anything unexpected → null. */
export function clientOf(
  c: { req: { header: (name: string) => string | undefined } },
): string | null {
  const v = c.req.header("x-vansen-client");
  return v && KNOWN_CLIENTS.has(v) ? v : null;
}

/** Short free-text field: control chars stripped, trimmed, capped, null if empty. */
export function sanitizeLabel(v: unknown, max = 80): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u001f\u007f]/gu, "").trim().slice(0, max);
  return s || null;
}

/** What a delete request tells the customer: hidden now, bytes queued. */
export function deletionStatus(data: unknown): Record<string, unknown> {
  const result = (data ?? {}) as { status?: string; objects?: number };
  return {
    // `pending_job` means a render is still running and may yet hand us
    // bytes; the content is already hidden either way.
    status: result.status === "pending_job" ? "processing" : "accepted",
    objectsQueued: result.objects ?? 0,
  };
}
