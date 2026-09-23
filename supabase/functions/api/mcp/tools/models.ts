// list_models: the live families from buildCatalog() (the same catalog every
// app renders), each with its options, defaults and price per image, plus
// the styles and the upscale price. Not age-gated: /catalog is public.
import { z } from "npm:zod@4";
import { buildCatalog, type CatalogFamily } from "../../_shared/build-catalog.ts";
import { modelRows } from "../../catalog.ts";
import { ok, toolError } from "../results.ts";
import { resolveSettings } from "../options.ts";
import { defineTool } from "../tool-kit.ts";

function familyView(family: CatalogFamily) {
  const { batch: _batch, ...defaults } = family.defaults;
  const atDefaults = resolveSettings(family, undefined);
  const prices = family.combos.map((combo) => combo.credits[0]);
  return {
    id: family.id,
    label: family.label,
    provider: family.provider,
    blurb: family.blurb,
    plan: family.plan,
    options: Object.fromEntries(family.axes.map((a) => [a.id, a.values.map((v) => v.value)])),
    defaults,
    creditsPerImage: "settings" in atDefaults ? atDefaults.creditsPerImage : null,
    creditsRange: { min: Math.min(...prices), max: Math.max(...prices) },
    maxImagesPerRequest: family.batch.max,
  };
}

export const listModels = defineTool({
  name: "list_models",
  title: "Vansen models",
  description:
    "The image models this Vansen account can use right now, with each model's options (valid values for generate_image's `options`), defaults and price per image in credits (1 credit = $0.01), plus the style presets. Read-only.",
  inputSchema: {
    kind: z.enum(["image", "video"]).optional().describe("Model kind; default image. Video is not available through this connection."),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  ageGated: false,
  async run(env, args) {
    const { data, error } = await env.ctx.admin.from("models").select("id,enabled,min_plan");
    if (error) {
      return toolError("catalog_unavailable", "Vansen couldn't read its model list.", "Try again in a moment.");
    }
    const catalog = buildCatalog(modelRows(data));
    const kind = args.kind ?? "image";
    const live = catalog.families.filter((f) => f.enabled && f.kind === kind);
    const result = {
      catalogVersion: catalog.catalogVersion,
      models: live.map(familyView),
      styles: catalog.styles.map((s) => ({ id: s.id, label: s.label, category: s.categoryLabel })),
      upscale: { creditsPerImage: catalog.flat.upscale.credits, enabled: catalog.flat.upscale.enabled, plan: catalog.flat.upscale.plan },
    };
    const names = live.map((f) => f.label).join(", ") || "none";
    return ok(`${live.length} ${kind} model${live.length === 1 ? "" : "s"} available: ${names}. 1 credit = $0.01.`, result);
  },
});
