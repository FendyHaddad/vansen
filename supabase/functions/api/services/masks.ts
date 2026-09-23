// Edit masks as owned uploads, for submitGeneration.
// storeMask() persists fresh base64 PNG bytes (registered, uploaded, recorded
// as allowed); existingMask() re-verifies a mask path that a retry names.
import type { Context } from "jsr:@hono/hono";
import { markObjectLive, registerObject } from "../_shared/storage/registry.ts";
import type { Services } from "../lib/context.ts";
import { fail } from "../lib/http.ts";
import { sniffImage } from "../lib/images.ts";
import { REFUSAL_MESSAGE } from "./retry.ts";
import { SUPABASE_BUCKETS } from "./object-storage.ts";

export function createMasks(
  ctx: Pick<Services, "admin" | "logError" | "removeTracked">,
) {
  const { admin, logError, removeTracked } = ctx;

  /**
   * Persist an edit mask as an owned upload and return its path.
   *
   * It arrives as base64 in the request because that is what the editor has,
   * but it must not travel in the job payload: the worker dispatches hours
   * later, and an unbounded blob with no owner and no moderation record is not
   * something to keep in a row.
   */
  async function storeMask(
    c: Context,
    userId: string,
    raw: unknown,
  ): Promise<string | null | Response> {
    if (typeof raw !== "string" || raw.length === 0) return null;
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(atob(raw), (ch) => ch.charCodeAt(0));
    } catch {
      return fail(c, 400, "invalid_payload", "Mask must be base64 PNG");
    }
    if (sniffImage(bytes) !== "png") {
      return fail(c, 400, "invalid_payload", "Mask must be a PNG");
    }
    const path = `${userId}/${crypto.randomUUID()}.png`;
    const objectId = await registerObject(admin, {
      userId,
      backend: "supabase",
      bucket: SUPABASE_BUCKETS.upload,
      path,
      purpose: "upload",
    }).catch((e) => {
      logError(c, "mask_register_failed", e);
      return null;
    });
    if (!objectId) {
      return fail(c, 503, "mask_unavailable", "Could not store your mask.");
    }
    const { error: upErr } = await admin.storage.from("uploads").upload(
      path,
      bytes,
      { contentType: "image/png" },
    );
    if (upErr) {
      return fail(c, 503, "mask_unavailable", "Could not store your mask.");
    }
    await markObjectLive(admin, objectId);
    // A mask is a shape, not a picture of anything — it is moderated by the
    // image it is applied to, so it is registered as allowed on arrival.
    const { error: regErr } = await admin.from("uploads").insert({
      user_id: userId,
      path,
      purpose: "mask",
      mime: "image/png",
      bytes: bytes.byteLength,
      width: 0,
      height: 0,
      moderation: "allowed",
    });
    if (regErr) {
      await removeTracked(c, userId, "upload", path, "mask_register_failed");
      return fail(c, 503, "mask_unavailable", "Could not store your mask.");
    }
    return path;
  }

  /**
   * A mask this user already owns, for a retry. Re-verified rather than
   * trusted: the path arrives from a snapshot, but a snapshot is data and the
   * upload behind it may have been deleted or may never have been theirs.
   */
  async function existingMask(
    c: Context,
    userId: string,
    path: string,
  ): Promise<string | Response> {
    const { data } = await admin.from("uploads")
      .select("path")
      .eq("user_id", userId).eq("path", path).eq("purpose", "mask")
      .maybeSingle();
    if (!data) {
      return fail(
        c,
        409,
        "reference_unavailable",
        REFUSAL_MESSAGE.reference_unavailable,
      );
    }
    return data.path as string;
  }

  return { storeMask, existingMask };
}
