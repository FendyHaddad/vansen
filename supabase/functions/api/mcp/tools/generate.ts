// generate_image: validates the model and options against the live catalog,
// then submits through submitGeneration (op 'generate') and waits up to 25 s
// for the images (submit.ts). Spends credits; the description says how many.
import { z } from "npm:zod@4";
import { buildCatalog, IMAGE_BATCH_MAX } from "../../_shared/build-catalog.ts";
import { GenerationOp } from "../../_shared/enums.ts";
import { modelRows } from "../../catalog.ts";
import { MAX_PROMPT_LEN } from "../../lib/request-sanitize.ts";
import { resolveModel, resolveSettings } from "../options.ts";
import { toolError } from "../results.ts";
import { submitAndWait } from "../submit.ts";
import { defineTool } from "../tool-kit.ts";

/** The price span every image family's combos cover, from the catalog itself. */
function priceSpan(): { min: number; max: number } {
  const prices = buildCatalog([]).families.filter((f) => f.kind === "image")
    .flatMap((f) => f.combos.map((combo) => combo.credits[0]));
  return { min: Math.min(...prices), max: Math.max(...prices) };
}
const SPAN = priceSpan();
const usd = (credits: number) => `$${(credits / 100).toFixed(2)}`;

export const generateImage = defineTool({
  name: "generate_image",
  title: "Generate images",
  description:
    `Generate 1–${IMAGE_BATCH_MAX} images from a text prompt on the user's Vansen account. SPENDS CREDITS: ` +
    `${SPAN.min}–${SPAN.max} credits (${usd(SPAN.min)}–${usd(SPAN.max)}) per image depending on model and options ` +
    "(exact prices from list_models); a failed image is refunded. Waits up to 25 s and returns the images; " +
    "if they are still rendering it returns their ids — call get_generation to collect them.",
  inputSchema: {
    prompt: z.string().min(1).max(MAX_PROMPT_LEN).describe("What to draw."),
    model: z.string().optional().describe("Model id or label from list_models; default the first listed."),
    options: z.record(z.string(), z.union([z.string(), z.number()])).optional()
      .describe("Option ids from list_models (e.g. aspectRatio, resolution, quality, version) to values."),
    count: z.number().int().min(1).max(IMAGE_BATCH_MAX).optional().describe("How many images (default 1)."),
    idempotency_key: z.string().max(200).optional()
      .describe("Reuse the same key when retrying the same request, so it is never charged twice."),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  ageGated: true,
  async run(env, args, call) {
    const { data, error } = await env.ctx.admin.from("models").select("id,enabled,min_plan");
    if (error) {
      return toolError("catalog_unavailable", "Vansen couldn't read its model list.", "Try again in a moment.");
    }
    const catalog = buildCatalog(modelRows(data));
    const family = resolveModel(catalog, args.model);
    if ("result" in family) return family;
    const resolved = resolveSettings(family, args.options);
    if ("result" in resolved) return resolved;

    const body: Record<string, unknown> = {
      op: GenerationOp.Generate,
      familyId: family.id,
      prompt: args.prompt,
      batch: args.count ?? 1,
      settings: resolved.settings,
    };
    return await submitAndWait(env, call, "generate_image", args, (key) =>
      env.ctx.submitGeneration(env.c, body, { idempotencyKey: key }));
  },
});
