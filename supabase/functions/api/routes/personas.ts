// Personas: GET/POST /personas, DELETE /personas/:id and
// PUT /personas/:id/photos/:slot. Slots are reserved under a lock by
// fn_reserve_persona; deleted photos are queued, nothing is trained.
// DTO and slot helpers live in personas.ts.
import {
  PERSONA_MIN_EDGE,
  PERSONA_NAME_MAX,
  PERSONA_SLOTS,
} from "../_shared/model-families.ts";
import { resolveOwnedUpload } from "../_shared/reference-resolver.ts";
import { isPersonaSlot, personaPhotoFailure, toPersonaDto } from "../personas.ts";
import { bodyHash, readIdempotencyKey } from "../services/idempotency.ts";
import type { ApiContext, App } from "../lib/context.ts";
import { clientOf, deletionStatus, fail } from "../lib/http.ts";

export function registerPersonaRoutes(app: App, ctx: ApiContext): void {
  const { admin, browserUrl, activePlan, isSuspended, logError } = ctx;

  /**
   * List personas. Read-only: a persona is only ever changed by its own
   * routes, so there is nothing here for a background worker to advance.
   */
  app.get("/personas", async (c) => {
    const userId = c.get("userId");
    const { data: fresh } = await admin
      .from("personas")
      .select("*")
      .eq("user_id", userId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false });

    const plan = await activePlan(userId);
    const max = plan ? PERSONA_SLOTS[plan] : 0;
    const items = await Promise.all(
      (fresh ?? []).map((row) => toPersonaDto(admin, browserUrl, row)),
    );
    // Every row this query returns is already draft or ready: deleted_at is
    // filtered above, and those are the only two statuses a persona has (0032).
    return c.json({ items, slots: { used: items.length, max } });
  });

  /** Create a draft persona. The slot check is the locked reservation, not a
   * count query here: two concurrent creates must not both slip under the cap. */
  app.post("/personas", async (c) => {
    const userId = c.get("userId");
    if (await isSuspended(userId)) {
      return fail(
        c,
        429,
        "account_suspended",
        "Account suspended — contact support to appeal.",
      );
    }
    const plan = await activePlan(userId);
    if (!plan) {
      return fail(
        c,
        403,
        "studio_required",
        "Personas require an active subscription.",
      );
    }
    const body = await c.req.json().catch(() => null);
    const name = typeof body?.name === "string"
      ? body.name.replace(/[\u0000-\u001f\u007f]/gu, "").trim()
      : "";
    if (!name || name.length > PERSONA_NAME_MAX) {
      return fail(c, 400, "invalid_payload", `name required (max ${PERSONA_NAME_MAX} chars)`);
    }
    if (body?.attested !== true) {
      return fail(c, 400, "invalid_payload", "Consent attestation is required");
    }
    const { data: reserved, error: reserveErr } = await admin.rpc("fn_reserve_persona", {
      p_user: userId,
      p_key: readIdempotencyKey(c) ?? crypto.randomUUID(),
      p_hash: await bodyHash({ name }),
      p_name: name,
    });
    if (reserveErr?.message?.includes("slot_limit")) {
      return fail(c, 403, "slot_limit", `Your plan allows ${PERSONA_SLOTS[plan]} personas`);
    }
    if (reserveErr?.message?.includes("idempotency_conflict")) {
      return fail(c, 409, "idempotency_conflict",
        "That request id was already used for a different request.");
    }
    if (reserveErr?.message?.includes("subscription_required")) {
      return fail(c, 403, "studio_required", "Personas require an active subscription.");
    }
    if (reserveErr || !reserved?.personaId) {
      logError(c, "persona_create_failed", reserveErr ?? new Error("no persona"));
      return fail(c, 503, "create_failed", "Could not create the persona");
    }
    const { data: row } = await admin.from("personas").select("*")
      .eq("id", reserved.personaId).single();
    // A replayed idempotency key can outlive the persona it made: the row may
    // since have been deleted. That is a 404, not a crash on a null row.
    if (!row) return fail(c, 404, "not_found", "Persona not found");
    const { error: clientErr } = await admin.from("personas")
      .update({ client: clientOf(c) }).eq("id", reserved.personaId);
    if (clientErr) logError(c, "persona_client_update_failed", clientErr);
    return c.json({ item: await toPersonaDto(admin, browserUrl, row) });
  });

  /**
   * Delete a persona. Its photos are queued for deletion from the registry;
   * nothing is trained and no provider holds a file for us any more (0032).
   */
  app.delete("/personas/:id", async (c) => {
    const { data, error } = await admin.rpc("fn_delete_persona", {
      p_user: c.get("userId"),
      p_id: c.req.param("id"),
    });
    if (error?.message?.includes("not_found")) {
      return fail(c, 404, "not_found", "Persona not found");
    }
    if (error) {
      logError(c, "delete_failed", error);
      return fail(c, 503, "delete_failed", "Could not delete — try again.");
    }
    return c.json(deletionStatus(data), 202);
  });

  /** Put one moderated photo in one slot; the replaced photo is queued for deletion. */
  app.put("/personas/:id/photos/:slot", async (c) => {
    const userId = c.get("userId");
    const personaId = c.req.param("id");
    const slot = c.req.param("slot");
    if (!isPersonaSlot(slot)) {
      return fail(c, 400, "invalid_slot", "Unknown photo slot");
    }
    if (await isSuspended(userId)) {
      return fail(c, 429, "account_suspended", "Account suspended — contact support to appeal.");
    }
    const body = await c.req.json().catch(() => null);
    const uploadId = typeof body?.uploadId === "string" ? body.uploadId : "";
    const owned = await resolveOwnedUpload(admin, userId, uploadId, "persona-photo");
    if (typeof owned === "string") {
      const refused = personaPhotoFailure(owned);
      return fail(c, refused.status, "invalid_reference", refused.message);
    }
    if (Math.min(owned.width, owned.height) < PERSONA_MIN_EDGE) {
      return fail(c, 400, "photo_too_small",
        `Use a sharper photo — at least ${PERSONA_MIN_EDGE}px on its short edge.`);
    }
    const { error } = await admin.rpc("fn_set_persona_photo", {
      p_user: userId, p_persona: personaId, p_slot: slot, p_path: owned.path,
    });
    if (error?.message?.includes("not_found")) {
      return fail(c, 404, "not_found", "Persona not found");
    }
    if (error?.message?.includes("invalid_slot")) {
      return fail(c, 400, "invalid_slot", "Unknown photo slot");
    }
    if (error?.message?.includes("invalid_photo")) {
      return fail(c, 409, "photo_unavailable",
        "That photo can't be used here — it's in use by another persona or being removed. " +
          "Upload it again.");
    }
    if (error) {
      logError(c, "persona_photo_failed", error);
      return fail(c, 503, "persona_photo_failed", "Could not save the photo — try again.");
    }
    const { data: row } = await admin.from("personas").select("*").eq("id", personaId)
      .maybeSingle();
    // Deleted between the write and this read: the persona is gone, say so.
    if (!row) return fail(c, 404, "not_found", "Persona not found");
    return c.json({ item: await toPersonaDto(admin, browserUrl, row) });
  });
}
