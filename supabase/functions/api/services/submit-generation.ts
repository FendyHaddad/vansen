// The one generation submission path. Composer submits and server-rebuilt
// retries/variations all enter submitGeneration(c, body), so every run gets
// the same validation, entitlement checks, moderation, quote and snapshot.
// fn_reserve_generation charges and queues in one transaction; the worker
// renders. Entry: createSubmitGeneration(services).
import type { Context } from "jsr:@hono/hono";
import {
  CATALOG_VERSION,
  creditCost,
  editToolById,
  familyById,
  type ModelFamily,
  PERSONA_GEN,
  personaGenCreditCost,
  personaSettings,
  upscaleCreditCost,
  UPSCALER,
} from "../_shared/model-families.ts";
import { IMAGE_BATCH_MAX } from "../_shared/build-catalog.ts";
import { GenerationOp, LedgerType, MediaKind } from "../_shared/enums.ts";
import type { StoredPayload } from "../_shared/jobs/payload.ts";
import { captureSnapshot } from "../_shared/request-snapshot.ts";
import { safetyId } from "../_shared/safety.ts";
import { personaPrompt, readyPersona } from "../personas.ts";
import type { Services } from "../lib/context.ts";
import { clientOf, fail, sanitizeLabel } from "../lib/http.ts";
import { MAX_PROMPT_LEN, sanitizeSettings } from "../lib/request-sanitize.ts";
import { bodyHash, readIdempotencyKey } from "./idempotency.ts";
import {
  contentPolicyRefusal,
  createSubmissionReplay,
  idempotencyConflict,
  isRefusal,
} from "./submission-replay.ts";
import { validateSettings } from "./request-validation.ts";
import { createVideoPrep, slotsOf } from "./video-prep.ts";
import {
  createReservationFailure,
  optionRefusal,
  priceRequest,
  providerCostUsd,
} from "./generation-pricing.ts";
import { createMasks } from "./masks.ts";
import { createReferenceUrls } from "./reference-urls.ts";

// Nothing pushes from inside a request any more. `fn_settle_job` writes a
// notification_outbox row in the same transaction as the settlement, and
// `_shared/jobs/notifications.ts` delivers it on its own schedule (wired up
// in P5). A push that fails can no longer fail a paid request, and "was the
// customer told" is answerable from the database.

export interface SubmitOptions {
  /** A server-derived key (the MCP tools); wins over the Idempotency-Key header. */
  idempotencyKey?: string;
}

export function createSubmitGeneration(ctx: Services) {
  const {
    admin,
    moderate,
    adapterFor,
    logError,
    isSuspended,
    activePlan,
    modelGate,
    creditsOf,
    moderationFailure,
    recordStrike,
    toGenerationDtos,
  } = ctx;
  const { resolveVideoPrep } = createVideoPrep(ctx);
  const { storeMask, existingMask } = createMasks(ctx);
  const { uploadReferenceUrl, imageParentUrl } = createReferenceUrls(ctx);
  const { reservationFailure } = createReservationFailure(ctx);
  const { priorSubmission, claimRefusal, releaseRefusal } = createSubmissionReplay(admin);

  /**
   * Moderation gate — BEFORE charge and BEFORE any provider call. An outage
   * refuses the request; it never silently lets an unchecked prompt through.
   * A block strikes once per request: with a key, only the request that
   * records the refusal strikes, so a retry or a racing twin never does.
   */
  async function moderatePrompt(
    c: Context,
    userId: string,
    prompt: string,
    key: string | null,
    hash: string,
  ): Promise<Response | null> {
    const decision = await moderate({ text: prompt });
    if (decision.state === "unavailable") return moderationFailure(c, decision);
    if (decision.state !== "blocked") return null;
    const first = key ? await claimRefusal(userId, key, hash) : true;
    if (!first) return contentPolicyRefusal(c);
    try {
      await recordStrike(userId, "prompt", prompt, decision.categories);
    } catch (e) {
      if (key) await releaseRefusal(userId, key);
      throw e;
    }
    return contentPolicyRefusal(c);
  }

  /**
   * One submission path, whether the request came from the composer or was
   * rebuilt by the server from a snapshot. Retry re-enters here so it gets the
   * same validation, entitlement checks, moderation, quote and snapshot — the
   * old client-side retry skipped all of it and guessed at the fields.
   */
  async function submitGeneration(
    c: Context,
    // deno-lint-ignore no-explicit-any
    body: any,
    opts: SubmitOptions = {},
  ): Promise<Response> {
    const userId = c.get("userId");

    const op = body.op as string;
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    let batch = Number.isInteger(body.batch) ? (body.batch as number) : 1;
    let settings = sanitizeSettings(body.settings);
    const parentId = typeof body.parentId === "string" && body.parentId
      ? body.parentId
      : null;
    const personaId = typeof body.personaId === "string" && body.personaId
      ? body.personaId
      : null;
    const trendId = sanitizeLabel(body.trendId, 40);

    if (!Object.values(GenerationOp).includes(op as never)) {
      return fail(
        c,
        400,
        "invalid_op",
        `op must be one of ${Object.values(GenerationOp).join(", ")}`,
      );
    }
    if (!prompt) return fail(c, 400, "invalid_prompt", "Prompt required");
    if (prompt.length > MAX_PROMPT_LEN) {
      return fail(
        c,
        400,
        "invalid_prompt",
        `Prompt too long (max ${MAX_PROMPT_LEN} characters)`,
      );
    }
    if (batch < 1 || batch > IMAGE_BATCH_MAX) {
      return fail(c, 400, "invalid_batch", `batch must be 1–${IMAGE_BATCH_MAX}`);
    }
    if (
      (op === GenerationOp.Edit || op === GenerationOp.Upscale) && !parentId
    ) {
      return fail(c, 400, "invalid_parent", `${op} requires parentId`);
    }

    // A retry (same key, same body) is answered from its first outcome
    // before anything else runs: a refused request gets the same refusal,
    // never a second strike, and an accepted one is not moderated again (the
    // reservation replays it). The same key with a different body is a
    // conflict, so a changed prompt cannot ride an old key past moderation.
    const key = opts.idempotencyKey ?? readIdempotencyKey(c);
    const hash = await bodyHash(body);
    const prior = key ? await priorSubmission(userId, key) : null;
    if (prior && prior.body_hash !== hash) return idempotencyConflict(c);
    if (prior && isRefusal(prior)) return contentPolicyRefusal(c);

    // Suspension shield (2 strikes = out).
    if (await isSuspended(userId)) {
      return fail(
        c,
        429,
        "account_suspended",
        "Account suspended — contact support to appeal.",
      );
    }

    // Subscription gate: no active plan, no generation of any kind.
    const plan = await activePlan(userId);
    if (!plan) {
      return fail(
        c,
        403,
        "subscription_required",
        "An active subscription is required to generate.",
      );
    }

    // Persona: owned + ready, generate-op only. Rendered as Nano Banana Pro 4K
    // with the persona's five photos; the server resolves them, never the client.
    if (personaId && op !== GenerationOp.Generate) {
      return fail(c, 400, "invalid_op", "Personas support generate only");
    }
    // A persona run's references are its five photos; any other image would
    // be a sixth likeness nobody labelled.
    if (personaId && (parentId || body.referenceUploadId)) {
      return fail(
        c,
        400,
        "invalid_reference",
        "A persona uses its own photos. Remove the other reference image.",
      );
    }
    const found = personaId ? await readyPersona(admin, userId, personaId) : null;
    if (found instanceof Error) {
      logError(c, "persona_lookup_failed", found);
      return fail(c, 503, "persona_lookup_failed", "Could not read your persona. Try again.");
    }
    if (found === "unavailable") {
      return fail(c, 400, "persona_unavailable", "That persona is missing or unfinished.");
    }
    const persona = found;
    // The persona fixes version and size; only the ratio is the customer's,
    // and it must be one Nano Banana renders.
    if (persona) settings = personaSettings(String(settings.aspectRatio ?? "1:1"));
    const personaFamily = persona ? familyById("nano-banana") : undefined;
    const personaInvalid = personaFamily ? validateSettings(personaFamily, settings) : null;
    if (personaInvalid) {
      return optionRefusal(
        c,
        body.catalogVersion,
        "invalid_settings",
        `Personas do not offer ${personaInvalid.field} ${personaInvalid.value}.`,
      );
    }

    // The provider sees the persona instruction wrapped around the prompt;
    // moderation sees the customer's own prompt (the wrapper is ours) and the
    // stored prompt stays the customer's own text.
    const effectivePrompt = persona ? personaPrompt(prompt) : prompt;

    let familyId: string;
    let familyName: string;
    let kind: string;
    let unitCredits: number;
    /** Set for catalog families; edit tools and the upscaler price separately. */
    let quoteFamily: ModelFamily | undefined;

    if (op === GenerationOp.Upscale) {
      familyId = UPSCALER.id;
      familyName = UPSCALER.name;
      kind = MediaKind.Image;
      unitCredits = upscaleCreditCost();
    } else if (persona) {
      familyId = PERSONA_GEN.id;
      familyName = PERSONA_GEN.name;
      kind = MediaKind.Image;
      // Priced as a persona, rendered as Nano Banana Pro: the quote family
      // builds the provider request, the persona price is the charge.
      quoteFamily = personaFamily;
      unitCredits = personaGenCreditCost();
    } else {
      const editTool = editToolById(String(body.familyId ?? ""));
      if (editTool) {
        // Studio panel AI tool — fixed credit price, edit op only.
        if (op !== GenerationOp.Edit) {
          return fail(c, 400, "invalid_op", "Edit tools use op=edit");
        }
        // A retry names a mask that is already stored; the composer sends
        // bytes. Either satisfies the requirement.
        const hasMask = typeof body.maskPngBase64 === "string" ||
          (typeof body.maskUploadId === "string" && !!body.maskUploadId);
        if (editTool.needsMask && !hasMask) {
          return fail(
            c,
            400,
            "invalid_payload",
            `${editTool.name} requires a mask`,
          );
        }
        familyId = editTool.id;
        familyName = editTool.name;
        kind = MediaKind.Image;
        unitCredits = editTool.creditCost; // fixed — no margin formula
      } else {
        const family = familyById(String(body.familyId ?? ""));
        if (!family) {
          return optionRefusal(c, body.catalogVersion, "invalid_family", "Unknown model family");
        }
        if (
          family.kind === MediaKind.Video && op !== GenerationOp.Generate &&
          op !== GenerationOp.Variation
        ) {
          return fail(
            c,
            400,
            "invalid_op",
            "Video supports generate/variation only",
          );
        }
        if (family.kind === MediaKind.Video && plan === "studio") {
          return fail(
            c,
            403,
            "pro_required",
            "Video models require the Pro plan.",
          );
        }
        // The catalog is the contract: an axis this family does not offer must
        // never reach creditCost(), which would fall through to a default price
        // and charge for a request the provider will clamp or reject.
        const invalid = validateSettings(family, settings);
        if (invalid) {
          return optionRefusal(
            c,
            body.catalogVersion,
            "invalid_settings",
            `${family.name} does not offer ${invalid.field} ${invalid.value}.`,
          );
        }
        familyId = family.id;
        familyName = family.name;
        kind = family.kind;
        quoteFamily = family;
        // Provisional: re-quoted from the normalized request below, once the
        // reference is resolved and `hasReference` is actually known.
        unitCredits = creditCost(family, settings);
      }
    }

    // Kill switch + per-model plan floor.
    const gate = await modelGate(familyId);
    if (!gate.enabled) {
      return fail(
        c,
        503,
        "model_disabled",
        "This model is temporarily unavailable.",
      );
    }
    if (gate.minPlan === "pro" && plan === "studio") {
      return fail(c, 403, "pro_required", "This model requires the Pro plan.");
    }

    // Moderation gate (moderatePrompt). An accepted request being replayed
    // was moderated when it was accepted.
    const refused = prior ? null : await moderatePrompt(c, userId, prompt, key, hash);
    if (refused) return refused;

    const videoResult = await resolveVideoPrep(
      c,
      userId,
      kind,
      familyId,
      settings,
      body as Record<string, unknown>,
      parentId,
    );
    if (videoResult instanceof Response) return videoResult;
    const video = videoResult;
    if (video) batch = 1;

    // Resolve reference (parent generation or uploaded image) to a signed URL.
    // An UPLOADED reference travels with op=generate + referenceUploadId; a
    // LIBRARY parent travels with op=edit + parentId. Both end up as
    // SubmitCtx.referenceUrl.
    const referenceUploadId = typeof body.referenceUploadId === "string"
      ? body.referenceUploadId
      : null;
    if (video && referenceUploadId) {
      return optionRefusal(
        c,
        body.catalogVersion,
        "reference_unsupported",
        "Use the video reference slots for this model.",
      );
    }
    if (parentId && referenceUploadId) {
      return fail(c, 400, "invalid_reference", "Choose one reference source.");
    }
    const referenceFamily = familyById(familyId);
    if (referenceUploadId && !referenceFamily?.capabilities.imageInput) {
      return optionRefusal(
        c,
        body.catalogVersion,
        "reference_unsupported",
        "This model does not take a reference image.",
      );
    }

    const parentReference = parentId && !video
      ? await imageParentUrl(c, parentId, userId)
      : undefined;
    if (parentReference instanceof Response) return parentReference;
    const uploadReference = referenceUploadId
      ? await uploadReferenceUrl(c, userId, referenceUploadId)
      : undefined;
    if (uploadReference instanceof Response) return uploadReference;
    const referenceUrl = parentReference ?? uploadReference;

    const priced = quoteFamily
      ? priceRequest(c, quoteFamily, op, settings, {
        hasReference: !!referenceUrl || !!persona,
        referenceCount: persona ? persona.paths.length : (referenceUrl ? 1 : 0),
        hasMask: typeof body.maskPngBase64 === "string" ||
          (typeof body.maskUploadId === "string" && !!body.maskUploadId),
      }, body.catalogVersion)
      : null;
    if (priced instanceof Response) return priced;
    const normalized = priced?.normalized;
    if (priced && !persona) unitCredits = priced.credits;

    const ledgerType = op === GenerationOp.Variation
      ? LedgerType.Generate
      : (op as LedgerType);

    if (personaId && persona) settings.persona = personaId;
    if (trendId) settings.trend = trendId;

    // The versions travel with the row so a later reader can tell which catalog
    // and which pricing rule produced this charge.
    const storedSettings = normalized
      ? {
        ...settings,
        quoteVersion: normalized.quoteVersion,
        catalogVersion: normalized.catalogVersion,
      }
      : settings;

    // A mask is stored like any other input, with an owner and a moderation
    // record. Carrying base64 in the job payload would be an unbounded row
    // nothing owns.
    // A retry names a mask that is already stored and owned; the composer
    // sends fresh bytes. Both end up as an upload path.
    const maskUploadId = typeof body.maskUploadId === "string" && body.maskUploadId
      ? await existingMask(c, userId, body.maskUploadId)
      : await storeMask(c, userId, body.maskPngBase64);
    if (maskUploadId instanceof Response) return maskUploadId;

    const sid = await safetyId(userId);
    const payload: StoredPayload = {
      familyId,
      op,
      prompt: effectivePrompt,
      settings: { ...settings },
      providerModel: normalized?.providerModel ?? familyId,
      providerSettings: normalized?.providerSettings ?? {},
      quoteVersion: normalized?.quoteVersion ?? 0,
      catalogVersion: normalized?.catalogVersion ?? "",
      safetyId: sid,
      referenceUploadId: referenceUploadId ?? undefined,
      parentId: parentId ?? undefined,
      maskUploadId: maskUploadId ?? undefined,
      referenceSlots: video ? slotsOf(video) : undefined,
      personaId: personaId ?? undefined,
      trendId: trendId ?? undefined,
      mode: video?.mode,
    };

    // The request, recorded once, by owned identity. This is the only thing a
    // retry weeks from now has to work from, so it is built from the resolved
    // identities rather than from the client's body.
    // A persona run is stored and priced under the pseudo-family 'persona',
    // which is not a model. The snapshot records the family it renders on —
    // the one whose settings it stores, so /retryable validates against the
    // right catalog entry — and the persona id, which is what sends a retry
    // back through the persona branch.
    const snapshotFamilyId = persona && quoteFamily ? quoteFamily.id : familyId;

    const snapshot = captureSnapshot({
      // Checked against GenerationOp at the top of this route.
      op: op as GenerationOp,
      familyId: snapshotFamilyId,
      prompt,
      settings,
      referenceUploadIds: video
        ? [...video.referencePaths]
        : (referenceUploadId ? [referenceUploadId] : []),
      referenceSlots: {
        first: video?.mode === "keyframes" ? (video.referencePaths[0] ?? null) : null,
        last: video?.mode === "keyframes" ? (video.referencePaths[1] ?? null) : null,
        references: video && video.mode !== "keyframes" ? [...video.referencePaths] : [],
      },
      maskUploadId: maskUploadId ?? null,
      personaId: personaId ?? null,
      trendId: trendId ?? null,
      mode: video?.mode ?? null,
      parentId: parentId ?? null,
      catalogVersion: normalized?.catalogVersion ?? CATALOG_VERSION,
      quoteVersion: normalized?.quoteVersion ?? 0,
    });

    const items = Array.from({ length: batch }, () => ({
      kind,
      familyId,
      familyName,
      op,
      prompt,
      settings: storedSettings,
      priceCredits: unitCredits,
      mediaUrl: "", // filled when the provider job completes
      parentId,
      client: clientOf(c) ?? "",
    }));

    // One transaction decides everything: the caps, the charge, the generation
    // rows, their jobs and the provider expense. A crash anywhere takes the
    // charge with it — the old two-step left charged generations with no job,
    // which the stale sweep could never find.
    const reservation = await admin.rpc("fn_reserve_generation", {
      p_user: userId,
      p_key: key ?? crypto.randomUUID(),
      p_hash: hash,
      p_items: items,
      p_quote: {
        provider: adapterFor(familyId).provider,
        chargeType: ledgerType,
        unitCredits,
        unitProviderCostUsd: providerCostUsd(familyId, quoteFamily, settings),
        catalogVersion: normalized?.catalogVersion ?? "",
        quoteVersion: normalized?.quoteVersion ?? 0,
      },
      // The snapshot rides beside the payload and is written by the RPC, in
      // the same transaction as the charge. The client never names its id.
      p_payload: { ...payload, snapshot },
    });
    if (reservation.error) {
      return await reservationFailure(c, userId, reservation.error.message);
    }

    const generationIds = ((reservation.data ?? {}) as {
      generationIds?: string[];
    }).generationIds ?? [];
    // A replay returns the original ids; never re-serve one the user has
    // since deleted, and never another account's row.
    const { data: createdRows } = await admin
      .from("generations")
      .select("*")
      .eq("user_id", userId)
      .is("deleted_at", null)
      .in("id", generationIds);
    // 202: accepted, not finished. The worker executes it whether or not this
    // client is still here to watch.
    return c.json({
      items: await toGenerationDtos(createdRows ?? []),
      credits: await creditsOf(userId),
    }, 202);
  }

  return { submitGeneration };
}

export type SubmitGeneration = ReturnType<typeof createSubmitGeneration>["submitGeneration"];
