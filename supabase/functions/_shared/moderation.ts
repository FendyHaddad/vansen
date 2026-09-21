// Universal moderation gate — runs on every prompt and every image BEFORE any
// provider sees them, and BEFORE any charge. OpenAI omni-moderation (free,
// multimodal).
//
// This gate fails CLOSED. A missing key, an outage, a timeout or a malformed
// response returns `unavailable`, and callers must refuse the request with a
// 503 — never charge, never dispatch, never record a strike. Failing open would
// make "every image is moderated" untrue exactly when it matters most.

export type ModerationDecision =
  | { state: "allowed" }
  | { state: "blocked"; categories: Record<string, number> }
  | { state: "unavailable"; reason: string; retryAfterSeconds: number };

/** Alias kept so ApiDeps and other callers can name the return type. */
export type ModerationResult = ModerationDecision;

const DEFAULT_RETRY_S = 10;
const TIMEOUT_MS = 10_000;

function retryAfterOf(res: Response): number {
  const header = Number(res.headers.get("retry-after"));
  if (Number.isFinite(header) && header > 0) return Math.min(header, 300);
  return DEFAULT_RETRY_S;
}

export async function moderate(
  input: { text?: string; imageUrl?: string },
): Promise<ModerationDecision> {
  const parts: unknown[] = [];
  if (input.text) parts.push({ type: "text", text: input.text });
  if (input.imageUrl) {
    parts.push({ type: "image_url", image_url: { url: input.imageUrl } });
  }
  if (parts.length === 0) return { state: "allowed" };

  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) {
    console.error("moderation unavailable: OPENAI_API_KEY missing");
    return {
      state: "unavailable",
      reason: "moderation_key_missing",
      retryAfterSeconds: DEFAULT_RETRY_S,
    };
  }

  try {
    const res = await fetch("https://api.openai.com/v1/moderations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "omni-moderation-latest", input: parts }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error("moderation api error", res.status);
      return {
        state: "unavailable",
        reason: `moderation_http_${res.status}`,
        retryAfterSeconds: retryAfterOf(res),
      };
    }
    const data = await res.json();
    const result = data?.results?.[0];
    if (!result || typeof result.flagged !== "boolean") {
      console.error("moderation response malformed");
      return {
        state: "unavailable",
        reason: "moderation_malformed",
        retryAfterSeconds: DEFAULT_RETRY_S,
      };
    }
    if (!result.flagged) return { state: "allowed" };
    return { state: "blocked", categories: result.category_scores ?? {} };
  } catch (e) {
    console.error("moderation request threw", e);
    return {
      state: "unavailable",
      reason: "moderation_unreachable",
      retryAfterSeconds: DEFAULT_RETRY_S,
    };
  }
}
