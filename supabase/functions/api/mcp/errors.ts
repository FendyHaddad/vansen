// Gateway refusals as tool errors: the same codes the app gets, each with one
// plain sentence and what the user can do next. gatewayFailure() reads a
// non-2xx Response from a gateway service; unknown 4xx keep the gateway's own
// message; 5xx carry the errorId so support can find the row.
import { REFUSAL_MESSAGE, type RetryRefusal } from "../services/retry.ts";
import { APP_URL, BILLING_URL, toolError } from "./results.ts";
import type { ToolOutcome } from "./tool-kit.ts";

const MAPPED: Record<string, [sentence: string, action: string]> = {
  content_policy: [
    "That prompt breaks Vansen's content policy, so nothing was generated or charged.",
    "Do not retry or reword automatically; tell the user. Repeated violations suspend the account.",
  ],
  insufficient_credits: [
    "There aren't enough credits on this Vansen account for that.",
    `Top up at ${BILLING_URL}.`,
  ],
  pro_required: [
    "That needs the Vansen Pro plan.",
    `Upgrade at ${BILLING_URL}.`,
  ],
  subscription_required: [
    "Generating images needs an active Vansen plan.",
    `Subscribe at ${BILLING_URL}.`,
  ],
  account_suspended: [
    "This Vansen account is suspended after content-policy strikes.",
    "Contact Vansen support to appeal.",
  ],
  model_disabled: [
    "That model is temporarily unavailable.",
    "Pick another one from list_models.",
  ],
  age_unconfirmed: [
    "This Vansen account needs a confirmed date of birth first.",
    `Open ${APP_URL} and confirm it, then try again.`,
  ],
  catalog_stale: [
    "The model options changed.",
    "Call list_models and pick again.",
  ],
  idempotency_conflict: [
    "That idempotency_key was already used for a different request.",
    "Use a new key.",
  ],
  not_found: [
    "There is no item with that id in this Vansen library.",
    "Use list_recent to find the right id.",
  ],
  parent_not_ready: [
    "That image isn't finished yet.",
    "Wait for it with get_generation, then try again.",
  ],
  invalid_parent: [
    "That item isn't an image.",
    "Pick an image id from list_recent.",
  ],
  not_pending: ["That generation has already finished, so there is nothing to cancel.", ""],
  not_cancellable: ["This model can't be cancelled once it has started.", ""],
  request_limit_unavailable: [
    "Vansen can't take requests right now.",
    "Try again in a moment.",
  ],
};

/** The rate-limit refusal, with the wait the budget reported. */
export function rateLimited(retryAfterSeconds: number): ToolOutcome {
  return toolError(
    "rate_limited",
    "Too many image requests in the last minute.",
    `Wait about ${retryAfterSeconds} seconds and try again.`,
    { retryAfterSeconds },
  );
}

/** A refusal by code, with the gateway's message as the fallback sentence. */
export function mappedError(code: string, fallback: string, extra: Record<string, unknown> = {}): ToolOutcome {
  const mapped = MAPPED[code];
  if (mapped) return toolError(code, mapped[0], mapped[1], extra);
  const refusal = REFUSAL_MESSAGE[code as RetryRefusal];
  if (refusal) return toolError(code, refusal);
  if (code.startsWith("invalid_")) {
    return toolError(code, fallback || "That request isn't valid.", "Call list_models for the valid options.");
  }
  return toolError(code, fallback || "Vansen couldn't do that.");
}

/**
 * A conflict on a key we derived is not the user's doing (they gave no key):
 * the same call came back with a different body inside the retry window.
 */
function derivedKeyConflict(): ToolOutcome {
  return toolError(
    "idempotency_conflict",
    "Vansen couldn't take that request just now; nothing was charged.",
    "Try again in a few minutes.",
  );
}

/** A non-2xx gateway Response as a tool error. */
export async function gatewayFailure(
  res: Response,
  opts: { derivedKey?: boolean } = {},
): Promise<ToolOutcome> {
  const body = await res.json().catch(() => null);
  const error = (body?.error ?? {}) as { code?: string; message?: string; errorId?: string };
  const code = error.code ?? "internal";
  if (code === "idempotency_conflict" && opts.derivedKey) return derivedKeyConflict();
  if (code === "rate_limited") {
    return rateLimited(Number(res.headers.get("retry-after")) || 60);
  }
  if (res.status >= 500 && !MAPPED[code]) {
    const sentence = error.message ? error.message.replace(/\.?$/, ".") : "Something went wrong on Vansen's side.";
    // Some gateway messages already say what to do; never say it twice.
    const action = /try again/i.test(sentence) ? "" : "Try again in a moment.";
    return toolError(code, sentence, action, error.errorId ? { errorId: error.errorId } : {});
  }
  return mappedError(code, error.message ?? "");
}
