// Library writes: POST /edits/save (a locally edited canvas as a $0
// version), POST /library/import (the user's own image as a $0 root) and
// DELETE /generations/:id (tombstone now, the cleanup worker removes bytes).
// Rows are staged `pending` until their stored object is recorded.
import { GenerationOp, MediaKind } from "../_shared/enums.ts";
import { markObjectLive, registerObject } from "../_shared/storage/registry.ts";
import type { ImageCheck } from "../services/moderation-gate.ts";
import { SUPABASE_BUCKETS } from "../services/object-storage.ts";
import type { ApiContext, App } from "../lib/context.ts";
import { deletionStatus, fail } from "../lib/http.ts";
import { sniffImage, UPLOAD_MAX_BYTES } from "../lib/images.ts";

export function registerLibraryWriteRoutes(app: App, ctx: ApiContext): void {
  const {
    admin,
    activePlan,
    isSuspended,
    logError,
    toGenerationDto,
    writeScratch,
    moderateStoredImage,
    removeTracked,
    dropStagedObject,
    dropStagedRow,
  } = ctx;

  /** Persist a locally-edited canvas as a new $0 generation version. */
  app.post("/edits/save", async (c) => {
    const userId = c.get("userId");
    if (await isSuspended(userId)) {
      return fail(
        c,
        429,
        "account_suspended",
        "Account suspended — contact support to appeal.",
      );
    }
    if (!(await activePlan(userId))) {
      return fail(
        c,
        403,
        "subscription_required",
        "An active subscription is required for editing tools.",
      );
    }
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    const parentId = String(form?.get("parentId") ?? "");
    if (!(file instanceof File)) {
      return fail(c, 400, "upload_failed", "No file provided");
    }
    if (file.size > UPLOAD_MAX_BYTES) {
      return fail(c, 400, "upload_failed", "File exceeds 10MB");
    }
    if (!parentId) return fail(c, 400, "invalid_parent", "parentId required");

    const { data: parent } = await admin
      .from("generations")
      .select("id,prompt,settings")
      .eq("id", parentId)
      .eq("user_id", userId)
      .is("deleted_at", null)
      .maybeSingle();
    if (!parent) {
      return fail(c, 404, "not_found", "Parent generation not found");
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    if (sniffImage(bytes) !== "png") {
      return fail(c, 400, "upload_failed", "PNG required");
    }

    // Moderation BEFORE anything persists outside quarantine reach. A failed
    // scratch write is an outage: we must not write to `media` unchecked.
    const scratch = `scratch/${userId}/${crypto.randomUUID()}.png`;
    const scratchErr = await writeScratch(c, userId, scratch, bytes, "image/png");
    if (scratchErr) return scratchErr;
    let saveCheck: ImageCheck;
    try {
      saveCheck = await moderateStoredImage(c, userId, scratch, "png");
    } finally {
      await removeTracked(c, userId, "scratch", scratch, "scratch_cleanup");
    }
    if (!saveCheck.ok) return saveCheck.response;

    const { data: gen, error } = await admin
      .from("generations")
      .insert({
        user_id: userId,
        kind: MediaKind.Image,
        family_id: "studio",
        family_name: "Studio Edit",
        op: GenerationOp.Edit,
        prompt: parent.prompt,
        settings: parent.settings,
        price_credits: 0,
        // Staged, not done: a row only becomes `done` once the bytes are
        // stored AND that fact is persisted. Inserting `done` up front is how
        // library rows that point at nothing were created.
        status: "pending",
        media_url: "",
        parent_id: parentId,
      })
      .select("*")
      .single();
    if (error || !gen) {
      return fail(c, 400, "save_failed", "Could not save the edit");
    }

    const path = `${userId}/${gen.id}.png`;
    const objectId = await registerObject(admin, {
      userId,
      backend: "supabase",
      bucket: SUPABASE_BUCKETS.media,
      path,
      purpose: "media",
    }).catch((e) => {
      logError(c, "media_register_failed", e);
      return null;
    });
    if (!objectId) {
      await dropStagedRow(gen.id);
      return fail(c, 503, "save_failed", "Could not record the file");
    }
    const { error: upErr } = await admin.storage.from("media").upload(
      path,
      bytes,
      {
        contentType: "image/png",
        upsert: true,
      },
    );
    if (upErr) {
      await dropStagedRow(gen.id);
      return fail(c, 400, "save_failed", "Storage rejected the file");
    }
    await markObjectLive(admin, objectId);
    const { data: saved, error: saveError } = await admin.from("generations")
      .update({ media_path: path, status: "done" })
      .eq("id", gen.id)
      .eq("user_id", userId)
      .select("id")
      .maybeSingle();
    if (saveError || !saved) {
      await dropStagedObject(gen.id, path);
      await dropStagedRow(gen.id);
      return fail(
        c,
        503,
        "save_failed",
        "Your image could not be saved. Please retry.",
      );
    }
    return c.json({
      item: await toGenerationDto({ ...gen, media_path: path, status: "done" }),
    });
  });

  /** Import a user's own image as a root $0 library item they can edit. Studio-gated. */
  app.post("/library/import", async (c) => {
    const userId = c.get("userId");
    if (await isSuspended(userId)) {
      return fail(
        c,
        429,
        "account_suspended",
        "Account suspended — contact support to appeal.",
      );
    }
    if (!(await activePlan(userId))) {
      return fail(
        c,
        403,
        "subscription_required",
        "An active subscription is required for editing tools.",
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
    const contentType = `image/${ext === "jpg" ? "jpeg" : ext}`;

    // Moderate BEFORE the image enters the library.
    const scratch = `scratch/${userId}/${crypto.randomUUID()}.${ext}`;
    const scratchErr = await writeScratch(c, userId, scratch, bytes, contentType);
    if (scratchErr) return scratchErr;
    let importCheck: ImageCheck;
    try {
      importCheck = await moderateStoredImage(c, userId, scratch, ext);
    } finally {
      await removeTracked(c, userId, "scratch", scratch, "scratch_cleanup");
    }
    if (!importCheck.ok) return importCheck.response;

    const { data: gen, error } = await admin
      .from("generations")
      .insert({
        user_id: userId,
        kind: MediaKind.Image,
        family_id: "studio",
        family_name: "Imported",
        op: GenerationOp.Generate,
        prompt: "Imported image",
        settings: {},
        price_credits: 0,
        // See /edits/save: staged until the stored object is recorded.
        status: "pending",
        media_url: "",
      })
      .select("*")
      .single();
    if (error || !gen) {
      return fail(c, 400, "save_failed", "Could not import the image");
    }

    const path = `${userId}/${gen.id}.${ext}`;
    const objectId = await registerObject(admin, {
      userId,
      backend: "supabase",
      bucket: SUPABASE_BUCKETS.media,
      path,
      purpose: "media",
    }).catch((e) => {
      logError(c, "media_register_failed", e);
      return null;
    });
    if (!objectId) {
      await dropStagedRow(gen.id);
      return fail(c, 503, "save_failed", "Could not record the file");
    }
    const { error: upErr } = await admin.storage.from("media").upload(
      path,
      bytes,
      {
        contentType,
        upsert: true,
      },
    );
    if (upErr) {
      await dropStagedRow(gen.id);
      return fail(c, 400, "save_failed", "Storage rejected the file");
    }
    await markObjectLive(admin, objectId);
    const { data: saved, error: saveError } = await admin.from("generations")
      .update({ media_path: path, status: "done" })
      .eq("id", gen.id)
      .eq("user_id", userId)
      .select("id")
      .maybeSingle();
    if (saveError || !saved) {
      await dropStagedObject(gen.id, path);
      await dropStagedRow(gen.id);
      return fail(
        c,
        503,
        "save_failed",
        "Your image could not be saved. Please retry.",
      );
    }
    return c.json({
      item: await toGenerationDto({ ...gen, media_path: path, status: "done" }),
    });
  });

  /**
   * Hide it now, remove the bytes durably.
   *
   * The route no longer deletes objects itself: it could only ever be
   * best-effort, and a failed `storage.delete` left bytes nobody could name
   * again. `fn_delete_generation` tombstones the row, asks any running job to
   * stop (it never settles one — only the lease holder may), and queues every
   * registered locator for the cleanup worker. A generation whose job is
   * still running keeps its row until the job settles, so a late provider
   * output lands somewhere we can still delete it from.
   */
  app.delete("/generations/:id", async (c) => {
    const userId = c.get("userId") as string;
    const { data, error } = await admin.rpc("fn_delete_generation", {
      p_user: userId,
      p_id: c.req.param("id"),
    });
    if (error?.message?.includes("not_found")) {
      return fail(c, 404, "not_found", "Generation not found.");
    }
    if (error) {
      logError(c, "delete_failed", error);
      return fail(c, 503, "delete_failed", "Could not delete — try again.");
    }
    return c.json(deletionStatus(data), 202);
  });
}
