// upscale_image: op 'upscale' on a finished image through submitGeneration,
// with the app's own body (the parent's prompt and settings) and the same
// wait-then-return as generate_image.
import { z } from "npm:zod@4";
import { GenerationOp } from "../../_shared/enums.ts";
import { upscaleCreditCost } from "../../_shared/model-families.ts";
import { mappedError } from "../errors.ts";
import { submitAndWait } from "../submit.ts";
import { defineTool } from "../tool-kit.ts";

export const upscaleImage = defineTool({
  name: "upscale_image",
  title: "Upscale an image",
  description:
    `Upscale a finished Vansen image by id. SPENDS CREDITS: ${upscaleCreditCost()} credits ` +
    `($${(upscaleCreditCost() / 100).toFixed(2)}); refunded if it fails. Waits up to 25 s, like generate_image.`,
  inputSchema: {
    id: z.string().min(1).max(64).describe("The id of a finished image."),
    idempotency_key: z.string().max(200).optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  ageGated: true,
  async run(env, args, call) {
    const { data: parent } = await env.ctx.admin.from("generations")
      .select("id,prompt,settings")
      .eq("id", args.id).eq("user_id", env.userId).is("deleted_at", null)
      .maybeSingle();
    if (!parent) return mappedError("not_found", "");
    const body = {
      op: GenerationOp.Upscale,
      prompt: parent.prompt,
      settings: parent.settings,
      batch: 1,
      parentId: parent.id,
    };
    return await submitAndWait(env, call, "upscale_image", args, (key) =>
      env.ctx.submitGeneration(env.c, body, { idempotencyKey: key }));
  },
});
