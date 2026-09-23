// Signed URLs for a generation's single image reference.
// uploadReferenceUrl() resolves an owned uploaded reference; imageParentUrl()
// a finished library image. Lifted out of submitGeneration unchanged except
// that the request context and user are passed in instead of captured.
import type { Context } from "jsr:@hono/hono";
import { MediaKind } from "../_shared/enums.ts";
import { resolveOwnedUpload } from "../_shared/reference-resolver.ts";
import type { Services } from "../lib/context.ts";
import { fail } from "../lib/http.ts";
import { REF_SIGN_TTL_S } from "./video-prep.ts";

export function createReferenceUrls(
  ctx: Pick<Services, "admin" | "referenceFailure" | "signStored">,
) {
  const { admin, referenceFailure, signStored } = ctx;

  async function uploadReferenceUrl(
    c: Context,
    userId: string,
    uploadId: string,
  ): Promise<string | Response> {
    const owned = await resolveOwnedUpload(
      admin,
      userId,
      uploadId,
      "reference",
    );
    if (typeof owned === "string") return referenceFailure(c, owned);
    const { data: signed, error } = await admin.storage.from("uploads")
      .createSignedUrl(owned.path, REF_SIGN_TTL_S);
    if (error || !signed?.signedUrl) {
      return fail(
        c,
        503,
        "reference_unavailable",
        "Could not read your reference image — try again.",
      );
    }
    return signed.signedUrl;
  }

  async function imageParentUrl(
    c: Context,
    parentId: string,
    userId: string,
  ): Promise<string | Response> {
    const { data: parent, error } = await admin.from("generations")
      .select("id,kind,status,media_path,storage_backend")
      .eq("id", parentId).eq("user_id", userId).is("deleted_at", null)
      .maybeSingle();
    if (error) {
      return fail(
        c,
        503,
        "reference_unavailable",
        "Could not read your image. Try again.",
      );
    }
    if (!parent) {
      return fail(c, 404, "not_found", "Parent generation not found");
    }
    if (parent.kind !== MediaKind.Image) {
      return fail(c, 400, "invalid_parent", "Pick an image to edit.");
    }
    if (parent.status !== "done" || !parent.media_path) {
      return fail(c, 400, "parent_not_ready", "That image is not ready.");
    }
    // Goes through signMedia, so in staging this is a browser URL. It is only
    // tested for presence below; a provider gets its own signed URL in payload.ts.
    return signStored(parent.storage_backend, parent.media_path);
  }

  return { uploadReferenceUrl, imageParentUrl };
}
