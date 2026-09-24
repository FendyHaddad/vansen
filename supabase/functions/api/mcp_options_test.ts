// generate_image's model and option resolution against the live catalog
// (spec §4 "Model names"): id or label, catalog axis ids, valid values back.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { buildCatalog } from "./_shared/build-catalog.ts";
import { resolveModel, resolveSettings } from "./mcp/options.ts";

const ALL_ON = buildCatalog([
  { id: "nano-banana", enabled: true },
  { id: "gpt-image", enabled: true },
  { id: "flux", enabled: true },
  { id: "seedream", enabled: true },
]);

function errorText(outcome: unknown): string {
  const o = outcome as { result: { isError?: boolean; content: { text: string }[] } };
  assert(o.result?.isError, "expected a tool error");
  return o.result.content[0].text;
}

Deno.test("a model resolves by id or by label, case-insensitively", () => {
  const byId = resolveModel(ALL_ON, "flux");
  assertEquals("id" in byId && byId.id, "flux");
  const label = ALL_ON.families.find((f) => f.id === "nano-banana")!.label;
  const byLabel = resolveModel(ALL_ON, label.toUpperCase());
  assertEquals("id" in byLabel && byLabel.id, "nano-banana");
});

Deno.test("no model picks the first live image family", () => {
  const picked = resolveModel(ALL_ON, undefined);
  assertEquals("id" in picked && picked.id, "nano-banana");
});

Deno.test("an unknown or switched-off model lists the valid ones", () => {
  const onlyFlux = buildCatalog([{ id: "flux", enabled: true }]);
  const off = errorText(resolveModel(onlyFlux, "nano-banana"));
  assertStringIncludes(off, "flux");
  assertStringIncludes(off, "model_disabled");
  const unknown = errorText(resolveModel(onlyFlux, "dall-e"));
  assertStringIncludes(unknown, "flux");
  assertStringIncludes(unknown, "invalid_model");
});

Deno.test("video families are never generate_image models", () => {
  const withVideo = buildCatalog([{ id: "kling", enabled: true }]);
  const text = errorText(resolveModel(withVideo, "kling"));
  assertStringIncludes(text, "model_disabled");
});

Deno.test("no options gives the family's defaults and their price", () => {
  const flux = ALL_ON.families.find((f) => f.id === "flux")!;
  const resolved = resolveSettings(flux, undefined);
  assert("settings" in resolved);
  const { batch: _batch, ...defaults } = flux.defaults;
  assertEquals(resolved.settings, defaults);
  assert(resolved.creditsPerImage > 0);
});

Deno.test("an invalid option value gets the catalog's valid values back", () => {
  const flux = ALL_ON.families.find((f) => f.id === "flux")!;
  const text = errorText(resolveSettings(flux, { aspectRatio: "7:3" }));
  assertStringIncludes(text, "aspectRatio");
  const ratios = flux.axes.find((a) => a.id === "aspectRatio")!.values.map((v) => String(v.value));
  assertStringIncludes(text, ratios[0]);
  assertStringIncludes(text, "invalid_settings");
});

Deno.test("an unknown option key names the axes the family has", () => {
  const flux = ALL_ON.families.find((f) => f.id === "flux")!;
  const text = errorText(resolveSettings(flux, { colour: "red" }));
  assertStringIncludes(text, "colour");
  assertStringIncludes(text, "aspectRatio");
});

Deno.test("a chosen value always lands on a real catalog combo", () => {
  for (const family of ALL_ON.families.filter((f) => f.kind === "image")) {
    for (const ratio of family.axes.find((a) => a.id === "aspectRatio")!.values) {
      const resolved = resolveSettings(family, { aspectRatio: ratio.value });
      assert("settings" in resolved, `${family.id} ${ratio.value}`);
      const match = family.combos.find((combo) =>
        JSON.stringify(combo.settings) === JSON.stringify(resolved.settings)
      );
      assert(match, `${family.id} ${ratio.value} is a combo`);
      assertEquals(resolved.creditsPerImage, match.credits[0]);
    }
  }
});
