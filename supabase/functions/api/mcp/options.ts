// generate_image's inputs checked against the live catalog before anything is
// charged: resolveModel() takes a family id or label, resolveSettings() the
// catalog axis ids (defaults fill the rest, and must land on a real combo),
// resolveStyle() a style id or label. Refusals list the valid values.
import type {
  Catalog,
  CatalogFamily,
  CatalogSettings,
} from "../_shared/build-catalog.ts";
import { toolError } from "./results.ts";
import type { ToolOutcome } from "./tool-kit.ts";

const squash = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, "");

/** Live image families, in catalog order. */
export function imageFamilies(catalog: Catalog): CatalogFamily[] {
  return catalog.families.filter((f) => f.kind === "image" && f.enabled);
}

export function resolveModel(catalog: Catalog, model: string | undefined): CatalogFamily | ToolOutcome {
  const live = imageFamilies(catalog);
  if (live.length === 0) {
    return toolError("model_disabled", "No image model is available right now.", "Try again later.");
  }
  if (!model) return live[0];
  const wanted = squash(model);
  const hit = live.find((f) => squash(f.id) === wanted || squash(f.label) === wanted);
  if (hit) return hit;
  const offTheList = catalog.families.find((f) => squash(f.id) === wanted || squash(f.label) === wanted);
  const valid = live.map((f) => `${f.id} (${f.label})`).join(", ");
  if (offTheList) {
    return toolError(
      "model_disabled",
      `${offTheList.label} isn't available for image generation right now.`,
      `Available: ${valid}.`,
      { valid: live.map((f) => f.id) },
    );
  }
  return toolError(
    "invalid_model",
    `There's no image model called "${model}".`,
    `Available: ${valid}.`,
    { valid: live.map((f) => f.id) },
  );
}

type Resolved = { settings: CatalogSettings; creditsPerImage: number };

/** Axis by axis, narrowing the combos; a default that no longer fits is replaced. */
export function resolveSettings(
  family: CatalogFamily,
  options: Record<string, unknown> | undefined,
): Resolved | ToolOutcome {
  const given = options ?? {};
  const axisIds = family.axes.map((a) => a.id as string);
  const unknown = Object.keys(given).filter((k) => !axisIds.includes(k));
  if (unknown.length) {
    return toolError(
      "invalid_settings",
      `${family.label} has no option ${unknown.map((k) => `"${k}"`).join(", ")}.`,
      `Its options are: ${axisIds.join(", ")}.`,
      { options: axisIds },
    );
  }

  let candidates = family.combos;
  const settings: CatalogSettings = {};
  for (const axis of family.axes) {
    const allowed = [...new Set(candidates.map((combo) => combo.settings[axis.id]))]
      .filter((v) => v !== undefined) as (string | number)[];
    const asked = given[axis.id];
    const fallback = family.defaults[axis.id];
    const wanted = asked ?? fallback;
    let chosen = allowed.find((v) => String(v) === String(wanted));
    if (chosen === undefined && asked !== undefined) {
      return toolError(
        "invalid_settings",
        `${family.label} doesn't offer ${axis.id} ${String(asked)} with the other options chosen.`,
        `Valid ${axis.id} values: ${allowed.map(String).join(", ")}.`,
        { option: axis.id, valid: allowed },
      );
    }
    chosen ??= allowed[0];
    settings[axis.id] = chosen;
    candidates = candidates.filter((combo) => String(combo.settings[axis.id]) === String(chosen));
  }
  const combo = candidates[0];
  if (!combo) {
    return toolError("invalid_settings", `${family.label} can't render that combination.`, "Call list_models for the valid options.");
  }
  return { settings: combo.settings, creditsPerImage: combo.credits[0] };
}

/** A style id, null for none, or a refusal listing the valid ids. */
export function resolveStyle(catalog: Catalog, style: string | undefined): string | null | ToolOutcome {
  if (!style) return null;
  const wanted = squash(style);
  const hit = catalog.styles.find((s) => squash(s.id) === wanted || squash(s.label) === wanted);
  if (hit) return hit.id;
  return toolError(
    "invalid_style",
    `There's no style called "${style}".`,
    `Valid styles: ${catalog.styles.map((s) => s.id).join(", ")}.`,
  );
}
