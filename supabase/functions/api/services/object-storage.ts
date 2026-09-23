// Where stored objects live, and how the routes remove them.
// SUPABASE_BUCKETS maps a purpose to its bucket (no default: see R11).
// removeTracked() deletes now or falls back to the deletion outbox;
// dropStagedObject/dropStagedRow roll back a staged library row.
import type { Context } from "jsr:@hono/hono";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import {
  enqueueDeletions,
  type ObjectPurpose,
  registerObject,
} from "../_shared/storage/registry.ts";
import type { LogError } from "../lib/errors.ts";

/** Which Supabase bucket a purpose lives in. There is no default: a delete
 * aimed at the wrong bucket silently misses, which is how R11 happened. */
export const SUPABASE_BUCKETS: Record<ObjectPurpose, string> = {
  media: "media",
  thumb: "media",
  upload: "uploads",
  "persona-photo": "uploads",
  "persona-zip": "uploads",
  scratch: "uploads",
  quarantine: "uploads",
};

export function createObjectStorage(admin: SupabaseClient, logError: LogError) {
  /**
   * The R2 bucket the deployment actually uses, as recorded in the database.
   * There is no default: naming the wrong bucket is a delete that misses.
   */
  async function r2Bucket(): Promise<string> {
    const { data, error } = await admin.rpc("fn_storage_config", {
      p_key: "r2_bucket",
    });
    if (error || !data) throw new Error("r2_bucket is not configured");
    return String(data);
  }

  /**
   * Remove one object now, and fall back to the deletion outbox when storage
   * refuses. The customer's request never fails on a bad minute at the storage
   * provider, and the bytes are never forgotten either.
   */
  async function removeTracked(
    c: Context,
    userId: string,
    purpose: ObjectPurpose,
    path: string,
    reason: string,
  ): Promise<void> {
    const bucket = SUPABASE_BUCKETS[purpose];
    const { error } = await admin.storage.from(bucket).remove([path]);
    if (!error) return;
    console.error("object_delete_deferred", { bucket, path, reason });
    try {
      const id = await registerObject(admin, {
        userId,
        backend: "supabase",
        bucket,
        path,
        purpose,
      });
      await enqueueDeletions(admin, [id], reason);
    } catch (e) {
      logError(c, "deletion_enqueue_failed", e);
    }
  }

  // A staged library row is only a promise of media. When the promise cannot be
  // kept, both halves are rolled back; a cleanup that itself fails leaves an
  // orphan, which P6's durable object registry is what finally collects.
  async function dropStagedObject(
    generationId: string,
    path: string,
  ): Promise<void> {
    const { error } = await admin.storage.from("media").remove([path]);
    if (!error) return;
    console.error("staged_object_cleanup_failed", {
      generationId,
      path,
      message: error.message,
    });
  }

  async function dropStagedRow(generationId: string): Promise<void> {
    const { error } = await admin.from("generations").delete().eq(
      "id",
      generationId,
    );
    if (!error) return;
    console.error("staged_row_cleanup_failed", {
      generationId,
      message: error.message,
    });
  }

  return { r2Bucket, removeTracked, dropStagedObject, dropStagedRow };
}

export type RemoveTracked = ReturnType<typeof createObjectStorage>["removeTracked"];
