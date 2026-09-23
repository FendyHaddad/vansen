// User image uploads: POST /uploads (references and persona photos) and
// POST /generations/:id/thumb (client-captured video posters). Every object
// is registered before it is written and moderated before it is usable.
import {
  PERSONA_MAX_BYTES,
  PERSONA_MIN_EDGE,
} from "../_shared/model-families.ts";
import { MediaKind } from "../_shared/enums.ts";
import { type StorageBackend, thumbPath } from "../_shared/storage/index.ts";
import { markObjectLive, registerObject } from "../_shared/storage/registry.ts";
import { imageSize } from "../_shared/image-size.ts";
import type { ImageCheck } from "../services/moderation-gate.ts";
import { SUPABASE_BUCKETS } from "../services/object-storage.ts";
import type { ApiContext, App } from "../lib/context.ts";
import { fail } from "../lib/http.ts";
import {
  sniffImage,
  UPLOAD_MAX_BYTES,
  UPLOAD_MAX_PIXELS,
} from "../lib/images.ts";

export function registerUploadRoutes(app: App, ctx: ApiContext): void {
  const {
    admin,
    storageFor,
    browserUrl,
    signStored,
    isSuspended,
    logError,
    moderateStoredImage,
    writeScratch,
    removeTracked,
    r2Bucket,
  } = ctx;

  app.post("/uploads", async (c) => {
    const userId = c.get("userId");
    if (await isSuspended(userId)) {
      return fail(
        c,
        429,
        "account_suspended",
        "Account suspended — contact support to appeal.",
      );
    }
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) {
      return fail(c, 400, "upload_failed", "No file provided");
    }
    if (file.size > UPLOAD_MAX_BYTES) {
      return fail(c, 400, "upload_failed", "File exceeds 10MB");
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const ext = sniffImage(bytes);
    if (!ext) {
      return fail(
        c,
        400,
        "upload_failed",
        "Only PNG, JPEG, or WEBP images are allowed",
      );
    }

    const dims = imageSize(bytes);
    if (!dims) {
      return fail(c, 400, "upload_failed", "Could not read the image dimensions");
    }
    if (dims.width * dims.height > UPLOAD_MAX_PIXELS) {
      return fail(
        c,
        400,
        "upload_too_large",
        "Image is too large — keep it under 50 megapixels",
      );
    }
    // The web client sends a 2048px JPEG at 0.92, typically 0.5–2 MB.
    if (form?.get("purpose") === "persona-photo" && file.size > PERSONA_MAX_BYTES) {
      return fail(c, 400, "photo_too_large",
        `Use a smaller photo — at most ${PERSONA_MAX_BYTES / (1024 * 1024)} MB.`);
    }
    const tooSmallForPersona = form?.get("purpose") === "persona-photo" &&
      Math.min(dims.width, dims.height) < PERSONA_MIN_EDGE;
    if (tooSmallForPersona) {
      return fail(c, 400, "photo_too_small",
        `Use a sharper photo — at least ${PERSONA_MIN_EDGE}px on its short edge.`);
    }

    const purpose = form?.get("purpose") === "persona-photo"
      ? "persona-photo"
      : "reference";
    const mime = `image/${ext === "jpg" ? "jpeg" : ext}`;
    const path = `${userId}/${crypto.randomUUID()}.${ext}`;
    // The locator is recorded BEFORE the bytes exist. An upload whose response
    // we never see still leaves something deletion can find.
    const objectId = await registerObject(admin, {
      userId,
      backend: "supabase",
      bucket: SUPABASE_BUCKETS.upload,
      path,
      purpose: purpose === "persona-photo" ? "persona-photo" : "upload",
    }).catch((e) => {
      logError(c, "upload_register_failed", e);
      return null;
    });
    if (!objectId) {
      return fail(c, 500, "upload_failed", "Could not record the upload");
    }
    const { error: upErr } = await admin.storage.from("uploads").upload(
      path,
      bytes,
      { contentType: mime },
    );
    if (upErr) {
      return fail(c, 400, "upload_failed", "Storage rejected the file");
    }
    await markObjectLive(admin, objectId);

    // Registry row first, as `pending`: an upload that never reaches `allowed`
    // can never be referenced, and deletion (P6/T08) still has its path.
    const { data: registered, error: regErr } = await admin
      .from("uploads")
      .insert({
        user_id: userId,
        path,
        purpose,
        mime,
        bytes: file.size,
        width: dims.width,
        height: dims.height,
        moderation: "pending",
      })
      .select("id")
      .single();
    if (regErr || !registered) {
      await admin.storage.from("uploads").remove([path]);
      logError(c, "upload_register_failed", new Error(regErr?.message ?? "no row"));
      return fail(c, 500, "upload_failed", "Could not record the upload");
    }

    // Moderate the image before it can be used as a reference.
    const check = await moderateStoredImage(c, userId, path, ext);
    if (!check.ok) {
      await admin.from("uploads").update({ moderation: "blocked" }).eq(
        "id",
        registered.id,
      );
      return check.response;
    }
    await admin.from("uploads").update({ moderation: "allowed" }).eq(
      "id",
      registered.id,
    );

    const { data: signed } = await admin.storage.from("uploads")
      .createSignedUrl(path, 600);
    return c.json({ uploadId: path, url: browserUrl(signed?.signedUrl ?? "") });
  });

  const THUMB_MAX_BYTES = 512 * 1024;

  app.post("/generations/:id/thumb", async (c) => {
    const userId = c.get("userId") as string;
    const generationId = c.req.param("id");
    const { data: gen } = await admin
      .from("generations")
      .select("id,kind,status,storage_backend,thumb_path")
      .eq("id", generationId)
      .eq("user_id", userId)
      .is("deleted_at", null)
      .maybeSingle();
    if (!gen || gen.kind !== MediaKind.Video) {
      return fail(c, 404, "not_found", "Video not found.");
    }
    if (gen.status !== "done") {
      return fail(c, 409, "not_ready", "Video is not finished.");
    }

    const form = await c.req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return fail(c, 400, "invalid_file", "Missing file.");
    }
    if (file.size > THUMB_MAX_BYTES) {
      return fail(c, 413, "too_large", "Thumbnail must be ≤ 512 KB.");
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (sniffImage(bytes) !== "jpg") {
      return fail(c, 415, "bad_type", "Thumbnail must be JPEG.");
    }

    // Posters are client-captured bytes, not a vetted server render: they cross
    // the same gate as any other user image before they are stored or served.
    const posterScratch = `scratch/${userId}/${crypto.randomUUID()}.jpg`;
    const posterErr = await writeScratch(c, userId, posterScratch, bytes, "image/jpeg");
    if (posterErr) return posterErr;
    let posterCheck: ImageCheck;
    try {
      posterCheck = await moderateStoredImage(c, userId, posterScratch, "jpg");
    } finally {
      await removeTracked(c, userId, "scratch", posterScratch, "scratch_cleanup");
    }
    if (!posterCheck.ok) return posterCheck.response;

    // The backend is the one RECORDED on the generation. The old `?? "r2"`
    // guess could write a poster into a store the row does not name, which
    // makes it undeletable and unsignable.
    const backend = gen.storage_backend as StorageBackend;
    if (backend !== "supabase" && backend !== "r2") {
      return fail(c, 409, "thumb_failed", "This video has no recorded storage.");
    }
    const path = thumbPath(userId, generationId);
    const posterId = await registerObject(admin, {
      userId,
      backend,
      bucket: backend === "r2" ? await r2Bucket() : SUPABASE_BUCKETS.thumb,
      path,
      purpose: "thumb",
    }).catch((e) => {
      logError(c, "thumb_register_failed", e);
      return null;
    });
    if (!posterId) {
      return fail(c, 503, "thumb_failed", "Could not record the thumbnail.");
    }
    await storageFor(backend).put(path, bytes, "image/jpeg");
    await markObjectLive(admin, posterId);
    const { error } = await admin.from("generations").update({
      thumb_path: path,
    }).eq("id", generationId);
    if (error) return fail(c, 500, "thumb_failed", error.message);
    return c.json({ thumbUrl: await signStored(backend, path) });
  });
}
