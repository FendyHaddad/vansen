// cancel_generation: the gateway's cancel service. Work that never started is
// refunded at once; running work is marked and refunded when the model
// confirms it stopped.
import { z } from "npm:zod@4";
import { gatewayFailure } from "../errors.ts";
import { ok } from "../results.ts";
import { defineTool } from "../tool-kit.ts";

export const cancelGeneration = defineTool({
  name: "cancel_generation",
  title: "Cancel a generation",
  description:
    "Cancel a pending Vansen generation by id. Work that has not started is refunded immediately; running work is refunded once the model confirms it stopped.",
  inputSchema: { id: z.string().min(1).max(64).describe("The id of a pending generation.") },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  ageGated: true,
  async run(env, args) {
    const res = await env.ctx.cancelGeneration(env.c, args.id);
    if (!res.ok) return await gatewayFailure(res);
    const body = await res.json() as { cancelling?: boolean; refundedCredits?: number; credits?: unknown };
    if (body.cancelling) {
      return ok(
        "Cancelling. The credits come back as a refund once the model confirms it stopped.",
        { id: args.id, cancelling: true, refundedCredits: 0, credits: body.credits },
      );
    }
    return ok(
      `Cancelled; ${body.refundedCredits ?? 0} credits refunded.`,
      { id: args.id, cancelled: true, refundedCredits: body.refundedCredits ?? 0, credits: body.credits },
    );
  },
});
