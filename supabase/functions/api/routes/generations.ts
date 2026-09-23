// Generation submission and replay: POST /generations, and
// POST /generations/:id/retry|variation plus GET /generations/:id/retryable,
// which rebuild the request from its snapshot and re-enter submitGeneration
// (services/submit-generation.ts).
import type { Context } from "jsr:@hono/hono";
import {
  editToolById,
  familyById,
  PERSONA_GEN,
  UPSCALER,
} from "../_shared/model-families.ts";
import type { GenerationRequestSnapshotV1 } from "../_shared/request-snapshot.ts";
import { readyPersona } from "../personas.ts";
import {
  planRetry,
  planVariation,
  REFUSAL_MESSAGE,
  REFUSAL_STATUS,
  type RetryContext,
  type RetryDecision,
} from "../services/retry.ts";
import { validateSettings } from "../services/request-validation.ts";
import type { ApiContext, App } from "../lib/context.ts";
import { fail } from "../lib/http.ts";

export function registerGenerationRoutes(app: App, ctx: ApiContext): void {
  const { admin, activePlan, modelGate, submitGeneration } = ctx;

  app.post("/generations", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body) return fail(c, 400, "invalid_payload", "JSON body required");
    return await submitGeneration(c, body);
  });

  /**
   * Rebuild the decision context for one generation.
   *
   * Everything `planRetry` needs, read once. `expressible` is the interesting
   * one: a price move is NOT a refusal (the retry is re-quoted and the
   * customer pays today's price), but a request that today's catalog can no
   * longer express — a withdrawn family, an option that no longer exists —
   * has no honest replay.
   */
  async function retryContextOf(
    userId: string,
    snapshotId: string | null,
  ): Promise<RetryContext> {
    const empty: RetryContext = {
      snapshot: null,
      liveUploadPaths: new Set<string>(),
      familyEnabled: false,
      entitled: false,
      expressible: false,
      personaUnavailable: false,
    };
    if (!snapshotId) return empty;

    const { data: row } = await admin.from("request_snapshots")
      .select("body").eq("id", snapshotId).eq("user_id", userId).maybeSingle();
    const snapshot = (row?.body ?? null) as GenerationRequestSnapshotV1 | null;
    if (!snapshot) return empty;

    const wanted = [...(snapshot.referenceUploadIds ?? [])];
    if (snapshot.maskUploadId) wanted.push(snapshot.maskUploadId);
    const live = new Set<string>();
    if (wanted.length) {
      const { data: uploads } = await admin.from("uploads")
        .select("path").eq("user_id", userId).in("path", wanted);
      for (const upload of uploads ?? []) live.add(upload.path as string);
    }

    // A persona run is gated by the persona kill switch, not its render family's.
    const gate = await modelGate(snapshot.personaId ? PERSONA_GEN.id : snapshot.familyId);
    const plan = await activePlan(userId);
    const persona = snapshot.personaId
      ? await readyPersona(admin, userId, snapshot.personaId)
      : null;
    const family = familyById(snapshot.familyId);
    // A fixed-price edit tool or the upscaler has no catalog family to
    // validate against; its options are the tool itself.
    const expressible = family
      ? validateSettings(family, snapshot.settings) === null
      : !!(editToolById(snapshot.familyId) || snapshot.familyId === UPSCALER.id ||
        snapshot.familyId === PERSONA_GEN.id);

    return {
      snapshot,
      liveUploadPaths: live,
      familyEnabled: gate.enabled,
      entitled: !(gate.minPlan === "pro" && plan === "studio"),
      expressible,
      personaUnavailable: persona === "unavailable",
    };
  }

  /** The generation, or a 404 — a stranger learns nothing either way. */
  async function ownedGeneration(
    c: Context,
    userId: string,
  ): Promise<{ id: string; snapshot_id: string | null } | Response> {
    const { data } = await admin.from("generations")
      .select("id,snapshot_id")
      .eq("id", c.req.param("id")).eq("user_id", userId)
      .is("deleted_at", null)
      .maybeSingle();
    if (!data) return fail(c, 404, "not_found", "Generation not found");
    return data as { id: string; snapshot_id: string | null };
  }

  function refuse(c: Context, decision: Extract<RetryDecision, { ok: false }>): Response {
    const status = REFUSAL_STATUS[decision.refusal] ?? 409;
    return fail(c, status, decision.refusal, REFUSAL_MESSAGE[decision.refusal]);
  }

  // Re-run what the customer actually asked for. The body is rebuilt here and
  // goes back through the normal submission path, so it is re-validated,
  // re-moderated, re-quoted at today's price and re-snapshotted.
  app.post("/generations/:id/retry", async (c) => {
    const userId = c.get("userId");
    const generation = await ownedGeneration(c, userId);
    if (generation instanceof Response) return generation;

    const decision = planRetry(await retryContextOf(userId, generation.snapshot_id));
    if (!decision.ok) return refuse(c, decision);
    return await submitGeneration(c, decision.body);
  });

  // Another take on the same prompt, hung off the original as its parent.
  app.post("/generations/:id/variation", async (c) => {
    const userId = c.get("userId");
    const generation = await ownedGeneration(c, userId);
    if (generation instanceof Response) return generation;

    const context = await retryContextOf(userId, generation.snapshot_id);
    const decision = planVariation(context, generation.id);
    if (!decision.ok) return refuse(c, decision);
    return await submitGeneration(c, decision.body);
  });

  // What the UI should enable. A disabled button with a reason is honest; a
  // button that always fails is not.
  app.get("/generations/:id/retryable", async (c) => {
    const userId = c.get("userId");
    const generation = await ownedGeneration(c, userId);
    if (generation instanceof Response) return generation;

    const context = await retryContextOf(userId, generation.snapshot_id);
    const retry = planRetry(context);
    const variation = planVariation(context, generation.id);
    const blocked = retry.ok ? null : retry.refusal;
    return c.json({
      retry: retry.ok,
      variation: variation.ok,
      reason: blocked ? REFUSAL_MESSAGE[blocked] : undefined,
    });
  });
}
