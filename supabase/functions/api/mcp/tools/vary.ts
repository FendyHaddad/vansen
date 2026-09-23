// vary_image: another take on a generated image's prompt, through the same
// variation service as POST /generations/:id/variation (re-validated,
// re-moderated, re-quoted), with generate_image's wait-then-return.
import { z } from "npm:zod@4";
import { submitAndWait } from "../submit.ts";
import { defineTool } from "../tool-kit.ts";

export const varyImage = defineTool({
  name: "vary_image",
  title: "Vary an image",
  description:
    "Make one new variation of a generated Vansen image (same prompt, model and options, a new take). SPENDS CREDITS at today's price for that model (see list_models); refunded if it fails. Waits up to 25 s, like generate_image.",
  inputSchema: {
    id: z.string().min(1).max(64).describe("The id of a generated image."),
    idempotency_key: z.string().max(200).optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  ageGated: true,
  async run(env, args, call) {
    return await submitAndWait(env, call, "vary_image", args, (key) =>
      env.ctx.varyGeneration(env.c, args.id, { idempotencyKey: key }));
  },
});
