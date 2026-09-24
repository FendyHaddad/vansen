// What a retried generation request (same user, same Idempotency-Key) already
// got, read BEFORE moderation. A flagged prompt whose response was lost used
// to be moderated again on retry and struck twice, and two strikes suspend
// the account.
//
// The refusal is kept in `submissions`, the table that already maps a key to
// its outcome, as result {refused: 'content_policy'}. Its primary key
// (user_id, idempotency_key) makes the record the race decider: only the
// request that writes it records the strike. fn_reserve_generation never sees
// such a row, because a same-key retry is answered here first and a
// different body under the same key is refused as a conflict.
import type { Context } from "jsr:@hono/hono";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { fail } from "../lib/http.ts";

const REFUSAL = "content_policy";
const UNIQUE_VIOLATION = "23505";

export interface PriorSubmission {
  body_hash: string;
  result: { refused?: string } | null;
}

export function isRefusal(prior: PriorSubmission): boolean {
  return prior.result?.refused === REFUSAL;
}

/** Same code and text as the reservation's own conflict answer. */
export function idempotencyConflict(c: Context): Response {
  return fail(
    c,
    409,
    "idempotency_conflict",
    "That request id was already used for a different request.",
  );
}

export function contentPolicyRefusal(c: Context): Response {
  return fail(c, 422, "content_policy", "This prompt violates our content policy.");
}

export function createSubmissionReplay(admin: SupabaseClient) {
  /** The key's first outcome, or null for a new request. A failed read
   * throws: guessing "new" could strike a retry twice. */
  async function priorSubmission(
    userId: string,
    key: string,
  ): Promise<PriorSubmission | null> {
    const { data, error } = await admin
      .from("submissions")
      .select("body_hash, result")
      .eq("user_id", userId)
      .eq("idempotency_key", key)
      .maybeSingle();
    if (error) throw new Error(`submission_read_failed ${error.message}`);
    return (data as PriorSubmission | null) ?? null;
  }

  /** Records the refusal under the key. False when another request with the
   * same key recorded first: that one strikes, this one does not. */
  async function claimRefusal(
    userId: string,
    key: string,
    hash: string,
  ): Promise<boolean> {
    const { error } = await admin.from("submissions").insert({
      user_id: userId,
      idempotency_key: key,
      body_hash: hash,
      result: { refused: REFUSAL },
    });
    if (!error) return true;
    if (error.code === UNIQUE_VIOLATION) return false;
    throw new Error(`submission_record_failed ${error.message}`);
  }

  /** Undoes a claim whose strike failed, so the retry strikes instead of
   * replaying a refusal with no evidence behind it. Best effort. */
  async function releaseRefusal(userId: string, key: string): Promise<void> {
    const { error } = await admin
      .from("submissions")
      .delete()
      .eq("user_id", userId)
      .eq("idempotency_key", key);
    if (error) console.error("submission_release_failed", error.message);
  }

  return { priorSubmission, claimRefusal, releaseRefusal };
}
