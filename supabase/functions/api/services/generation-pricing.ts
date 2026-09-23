// Pricing and charge-failure answers for submitGeneration.
// priceRequest() builds the provider request and its price as one object;
// optionRefusal() turns a stale-catalog miss into 409 catalog_stale;
// providerCostUsd() is our expected spend; reservationFailure() maps the
// reservation RPC's codes to customer answers.
import type { Context } from "jsr:@hono/hono";
import {
  editToolById,
  type GenerationInput,
  type GenerationSettings,
  type ModelFamily,
  PERSONA_GEN,
  personaProviderCost,
  STUDIO_MARGIN,
  UPSCALER,
} from "../_shared/model-families.ts";
import {
  normalizeGenerationRequest,
  type NormalizedRequest,
  quote,
} from "../_shared/generation-request.ts";
import { CATALOG_STALE, isStaleCatalog } from "../catalog.ts";
import type { Services } from "../lib/context.ts";
import { fail } from "../lib/http.ts";

/**
 * An option the catalog does not offer. From a client on an older catalog it
 * is not the client's bug — its picker is out of date — so it gets 409
 * catalog_stale and refreshes; everyone else gets the plain 400.
 */
export function optionRefusal(
  c: Context,
  sentCatalog: unknown,
  code: string,
  message: string,
): Response {
  if (isStaleCatalog(sentCatalog)) {
    return fail(c, 409, CATALOG_STALE.code, CATALOG_STALE.message);
  }
  return fail(c, 400, code, message);
}

/**
 * The price and the provider request as ONE object. They used to be derived
 * separately — the catalog priced by version and resolution while the adapter
 * hard-coded a model and a size — so a customer could pay the 4K price for a
 * 1K render. A combination the provider cannot render is a 400 here, never a
 * charge.
 */
export function priceRequest(
  c: Context,
  family: ModelFamily,
  op: string,
  settings: GenerationSettings,
  ctx: GenerationInput & { hasMask: boolean },
  sentCatalog: unknown,
): { normalized: NormalizedRequest; credits: number } | Response {
  try {
    const normalized = normalizeGenerationRequest(family, op, settings, ctx);
    return { normalized, credits: quote(normalized, family).credits };
  } catch {
    return optionRefusal(
      c,
      sentCatalog,
      "invalid_settings",
      `${family.name} cannot render that combination of options.`,
    );
  }
}

/**
 * What this run is expected to cost US, for the budget. The catalog knows it
 * for its own families; the fixed-price tools are priced backwards from their
 * retail credits, which is an estimate and is labelled as one.
 */
export function providerCostUsd(
  familyId: string,
  family: ModelFamily | undefined,
  settings: GenerationSettings,
): number {
  // Before the catalog family: a persona run carries Nano Banana as its
  // quote family, but its cost includes the five photos and the premium settings.
  if (familyId === PERSONA_GEN.id) return personaProviderCost();
  if (family) return family.providerCost(settings);
  if (familyId === UPSCALER.id) return UPSCALER.providerCost;
  const tool = editToolById(familyId);
  if (tool) return (tool.creditCost / 100) * (1 - STUDIO_MARGIN);
  return 0;
}

export function createReservationFailure(
  ctx: Pick<Services, "admin" | "logError">,
) {
  const { admin, logError } = ctx;

  /** The reservation raises plain codes; each one has a customer-facing answer. */
  async function reservationFailure(
    c: Context,
    userId: string,
    message: string,
  ): Promise<Response> {
    if (message.includes("idempotency_conflict")) {
      return fail(
        c,
        409,
        "idempotency_conflict",
        "That request id was already used for a different request.",
      );
    }
    if (message.includes("insufficient_balance")) {
      return fail(
        c,
        402,
        "insufficient_credits",
        "Not enough credits for this run",
      );
    }
    if (message.includes("too_many_jobs")) {
      return fail(
        c,
        429,
        "too_many_jobs",
        "3 videos are still rendering — wait for one to finish",
      );
    }
    if (message.includes("daily_cap")) {
      const { data: resetsAt } = await admin.rpc("fn_spend_resets_at", {
        p_user: userId,
      });
      return c.json({
        error: {
          code: "daily_cap",
          message: "Daily video limit reached.",
          resetsAt: resetsAt ?? null,
        },
      }, 429);
    }
    logError(c, "reservation_failed", new Error(message));
    return fail(c, 400, "charge_failed", "Charge could not be completed");
  }

  return { reservationFailure };
}
