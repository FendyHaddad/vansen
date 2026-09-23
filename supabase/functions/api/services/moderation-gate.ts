// The moderation gate for prompts and stored images.
// recordStrike, moderationFailure and referenceFailure answer the routes;
// writeScratch + moderateStoredImage stage bytes and check them. A blocked
// image is quarantined (held 12 months for appeals) and striked here.
import type { Context } from "jsr:@hono/hono";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { holdObject, registerObject } from "../_shared/storage/registry.ts";
import type { ModerationDecision } from "../_shared/moderation.ts";
import type { ReferenceError } from "../_shared/reference-resolver.ts";
import type { ApiDeps } from "../lib/deps.ts";
import type { LogError } from "../lib/errors.ts";
import { fail } from "../lib/http.ts";
import { type RemoveTracked, SUPABASE_BUCKETS } from "./object-storage.ts";

/** D2: quarantined evidence is kept for 12 months after the enforcement
 * action, for appeals and legal defence. See the retention policy spec. */
const EVIDENCE_HOLD_MS = 365 * 24 * 60 * 60 * 1000;

export type ImageCheck =
  | { ok: true }
  | { ok: false; response: Response };

export function createModerationGate(gateDeps: {
  admin: SupabaseClient;
  moderate: ApiDeps["moderate"];
  logError: LogError;
  removeTracked: RemoveTracked;
}) {
  const { admin, moderate, logError, removeTracked } = gateDeps;

  async function recordStrike(
    userId: string,
    source: "prompt" | "upload",
    prompt: string | null,
    categories: Record<string, number>,
    quarantinePath?: string,
  ): Promise<void> {
    const { error } = await admin.from("moderation_events").insert({
      user_id: userId,
      source,
      prompt,
      categories,
      quarantine_path: quarantinePath ?? null,
    });
    if (error) throw new Error("moderation_event_insert_failed");
    const { error: strikeError } = await admin.rpc("fn_increment_strike", {
      p_user: userId,
    });
    if (strikeError) throw new Error("moderation_strike_failed");
  }

  /** One response for a moderation outage: readable, retryable, never charged. */
  async function moderationFailure(
    c: Context,
    decision: Extract<ModerationDecision, { state: "unavailable" }>,
  ): Promise<Response> {
    const res = fail(
      c,
      503,
      "moderation_unavailable",
      "Safety check is unavailable right now. Nothing was charged — please try again shortly.",
    );
    res.headers.set("retry-after", String(decision.retryAfterSeconds));
    console.error("moderation_unavailable", decision.reason);
    const { error } = await admin.rpc("fn_raise_alert", {
      p_kind: "moderation_unavailable", p_severity: "critical",
      p_detail: { reason: decision.reason },
    });
    if (error) console.error("moderation_alert_failed", error.message);
    return res;
  }

  const REFERENCE_MESSAGES: Record<ReferenceError, string> = {
    not_found: "That reference image is no longer available — upload it again.",
    not_owned: "That reference image does not belong to you.",
    not_moderated: "That reference image has not finished its safety check.",
    wrong_purpose: "That image was not uploaded as a reference.",
  };

  function referenceFailure(c: Context, err: ReferenceError): Response {
    const status = err === "not_found" ? 404 : 403;
    return fail(c, status, "invalid_reference", REFERENCE_MESSAGES[err]);
  }

  /** Copy the bytes into quarantine for an appeal, then delete the original.
   * A failed copy must not leave `moderation_events` pointing at nothing.
   *
   * The copy is registered and immediately HELD: evidence is kept on purpose
   * for the D2 appeal window (12 months), so no purge, account closure or
   * inventory sweep may treat it as an orphan. */
  async function quarantine(
    userId: string,
    bucketPath: string,
    ext: string,
  ): Promise<string | null> {
    const target = `quarantine/${userId}/${crypto.randomUUID()}.${ext}`;
    let objectId: string;
    try {
      objectId = await registerObject(admin, {
        userId,
        backend: "supabase",
        bucket: "uploads",
        path: target,
        purpose: "quarantine",
      });
    } catch (e) {
      console.error("quarantine_register_failed", String(e));
      return null;
    }
    const { error } = await admin.storage.from("uploads").copy(
      bucketPath,
      target,
    );
    if (error) {
      console.error("quarantine_copy_failed", error.message);
      return null;
    }
    await holdObject(admin, objectId, new Date(Date.now() + EVIDENCE_HOLD_MS));
    return target;
  }

  /**
   * Stage bytes where moderation can read them. Returns an error Response, or
   * null when the write landed. The locator is registered first so a scratch
   * object survives a crash between the write and its cleanup.
   */
  async function writeScratch(
    c: Context,
    userId: string,
    path: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<Response | null> {
    const registered = await registerObject(admin, {
      userId,
      backend: "supabase",
      bucket: SUPABASE_BUCKETS.scratch,
      path,
      purpose: "scratch",
    }).catch((e) => {
      logError(c, "scratch_register_failed", e);
      return null;
    });
    if (!registered) {
      return moderationFailure(c, {
        state: "unavailable",
        reason: "scratch_register_failed",
        retryAfterSeconds: 10,
      });
    }
    const { error } = await admin.storage
      .from(SUPABASE_BUCKETS.scratch)
      .upload(path, bytes, { contentType });
    if (!error) return null;
    return moderationFailure(c, {
      state: "unavailable",
      reason: "scratch_write_failed",
      retryAfterSeconds: 10,
    });
  }

  async function refuseBlockedImage(
    c: Context,
    userId: string,
    path: string,
    ext: string,
    categories: Record<string, number>,
  ): Promise<ImageCheck> {
    const kept = await quarantine(userId, path, ext);
    if (!kept) {
      return {
        ok: false,
        response: await moderationFailure(c, {
          state: "unavailable",
          reason: "quarantine_copy_failed",
          retryAfterSeconds: 10,
        }),
      };
    }
    await recordStrike(userId, "upload", null, categories, kept);
    // The evidence copy is kept; the original goes. A failed removal here used
    // to be a log line and nothing else — it is now a durable cleanup job.
    await removeTracked(c, userId, "upload", path, "moderation_blocked");
    return {
      ok: false,
      response: fail(
        c,
        422,
        "content_policy",
        "This image violates our content policy.",
      ),
    };
  }

  /** Sign a just-written object and moderate it. Any failure to produce a real
   * signed URL is an outage, not a pass — we never call moderate() with an
   * undefined image. Blocked images are quarantined and striked here. */
  async function moderateStoredImage(
    c: Context,
    userId: string,
    path: string,
    ext: string,
  ): Promise<ImageCheck> {
    const { data: signed, error: signError } = await admin.storage
      .from("uploads")
      .createSignedUrl(path, 600);
    if (signError || !signed?.signedUrl) {
      await admin.storage.from("uploads").remove([path]);
      console.error(
        "moderation_sign_failed",
        signError?.message ?? "no signed url",
      );
      return {
        ok: false,
        response: await moderationFailure(c, {
          state: "unavailable",
          reason: "moderation_sign_failed",
          retryAfterSeconds: 10,
        }),
      };
    }
    const decision = await moderate({ imageUrl: signed.signedUrl });
    if (decision.state === "unavailable") {
      await admin.storage.from("uploads").remove([path]);
      return { ok: false, response: await moderationFailure(c, decision) };
    }
    if (decision.state === "blocked") {
      return refuseBlockedImage(c, userId, path, ext, decision.categories);
    }
    return { ok: true };
  }

  return {
    recordStrike,
    moderationFailure,
    referenceFailure,
    writeScratch,
    moderateStoredImage,
  };
}
