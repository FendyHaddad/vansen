import { assert, assertEquals } from 'jsr:@std/assert';
import {
  buildCatalog,
  type CatalogFamily,
  type CatalogSettings,
  IMAGE_BATCH_MAX,
  toGenerationSettings,
} from './_shared/build-catalog.ts';
import { CATALOG_VERSION, creditCost, familyById, MODEL_FAMILIES } from './_shared/model-families.ts';
import type { ModelFamily } from './_shared/model-families.ts';
import { normalizeGenerationRequest, quote } from './_shared/generation-request.ts';
import { validateSettings } from './services/request-validation.ts';
import { STYLE_PRESETS } from './_shared/style-presets.ts';
import { TREND_PRESETS } from './_shared/trend-presets.ts';

const ALL_ON = MODEL_FAMILIES.map((f) => ({ id: f.id, enabled: true, min_plan: 'studio' }));
const CATALOG = buildCatalog(ALL_ON);

function source(family: CatalogFamily): ModelFamily {
  const found = familyById(family.id);
  if (!found) throw new Error(`catalog lists unknown family ${family.id}`);
  return found;
}

function key(settings: CatalogSettings): string {
  return JSON.stringify(Object.entries(settings).sort(([a], [b]) => a.localeCompare(b)));
}

function cartesian(family: CatalogFamily): CatalogSettings[] {
  return family.axes.reduce<CatalogSettings[]>(
    (all, axis) => all.flatMap((s) => axis.values.map((v) => ({ ...s, [axis.id]: v.value }))),
    [{}],
  );
}

function renderable(family: ModelFamily, settings: CatalogSettings): boolean {
  const request = toGenerationSettings(settings);
  if (validateSettings(family, request) !== null) return false;
  try {
    normalizeGenerationRequest(family, 'generate', request, { hasReference: false, hasMask: false });
    return true;
  } catch {
    return false;
  }
}

function withoutBatch(defaults: CatalogFamily['defaults']): CatalogSettings {
  const { batch: _batch, ...settings } = defaults;
  return settings;
}

function familyOf(id: string): CatalogFamily {
  const found = CATALOG.families.find((f) => f.id === id);
  if (!found) throw new Error(`missing ${id}`);
  return found;
}

Deno.test('the catalog carries the catalog version and every live family', () => {
  assertEquals(CATALOG.catalogVersion, CATALOG_VERSION);
  assertEquals(CATALOG.families.map((f) => f.id), MODEL_FAMILIES.map((f) => f.id));
});

Deno.test('every combo price is creditCost for that many references', () => {
  for (const family of CATALOG.families) {
    const model = source(family);
    for (const combo of family.combos) {
      assertEquals(combo.credits.length, family.maxReferences + 1, `${family.id} ${key(combo.settings)}`);
      combo.credits.forEach((credits, n) => {
        const expected = creditCost(model, toGenerationSettings(combo.settings), {
          hasReference: n > 0,
          referenceCount: n,
        });
        assertEquals(credits, expected, `${family.id} ${key(combo.settings)} refs=${n}`);
      });
    }
  }
});

Deno.test('an image price is exactly what the gateway quote charges', () => {
  for (const family of CATALOG.families.filter((f) => f.kind === 'image')) {
    const model = source(family);
    for (const combo of family.combos) {
      combo.credits.forEach((credits, n) => {
        const request = normalizeGenerationRequest(model, 'generate', toGenerationSettings(combo.settings), {
          hasReference: n > 0,
          hasMask: false,
        });
        assertEquals(credits, quote(request, model).credits, `${family.id} ${key(combo.settings)} refs=${n}`);
      });
    }
  }
});

Deno.test('a combination is listed exactly when the gateway accepts it', () => {
  for (const family of CATALOG.families) {
    const model = source(family);
    const listed = new Set(family.combos.map((c) => key(c.settings)));
    for (const settings of cartesian(family)) {
      assertEquals(listed.has(key(settings)), renderable(model, settings), `${family.id} ${key(settings)}`);
    }
  }
});

Deno.test('every family default is a listed combo', () => {
  for (const family of CATALOG.families) {
    const listed = new Set(family.combos.map((c) => key(c.settings)));
    assert(listed.has(key(withoutBatch(family.defaults))), `${family.id} default is not a combo`);
    assertEquals(family.defaults.batch, 1);
  }
});

Deno.test('the models table decides enabled and plan; a missing row is off', () => {
  const catalog = buildCatalog([
    { id: 'flux', enabled: false, min_plan: 'studio' },
    { id: 'veo', enabled: true, min_plan: 'pro' },
    { id: 'edit-bg', enabled: true, min_plan: 'studio' },
  ]);
  const byId = new Map(catalog.families.map((f) => [f.id, f]));
  assertEquals(byId.get('flux')?.enabled, false);
  assertEquals(byId.get('veo')?.enabled, true);
  assertEquals(byId.get('veo')?.plan, 'pro');
  assertEquals(byId.get('nano-banana')?.enabled, false);
  assertEquals(byId.get('nano-banana')?.plan, 'studio');
  assertEquals(catalog.flat.editTools.find((t) => t.id === 'edit-bg')?.enabled, true);
  assertEquals(catalog.flat.editTools.find((t) => t.id === 'edit-fill')?.enabled, false);
  assertEquals(catalog.flat.upscale.enabled, false);
  assertEquals(catalog.flat.persona.enabled, false);
});

Deno.test('reference slots follow the catalog', () => {
  const max = Object.fromEntries(CATALOG.families.map((f) => [f.id, f.maxReferences]));
  assertEquals(max['flux'], 0);
  assertEquals(max['nano-banana'], 1);
  assertEquals(max['gpt-image'], 1);
  assertEquals(max['seedream'], 1);
  assertEquals(max['veo'], 3);
  assertEquals(max['kling'], 2);
  assertEquals(max['runway'], 1);
});

Deno.test('FLUX offers 4MP only at 1:1', () => {
  const ratios = familyOf('flux').combos
    .filter((c) => c.settings.resolution === '4MP')
    .map((c) => c.settings.aspectRatio);
  assertEquals([...new Set(ratios)], ['1:1']);
});

Deno.test('GPT Image offers only the 2.5 versions', () => {
  const version = familyOf('gpt-image').axes.find((a) => a.id === 'version');
  assertEquals(version?.values.map((v) => v.value), ['2.5-flare', '2.5-sunburst']);
});

Deno.test('batch: images take 1 to 4, a video exactly one', () => {
  assertEquals(familyOf('nano-banana').batch, { min: 1, max: IMAGE_BATCH_MAX });
  assertEquals(familyOf('veo').batch, { min: 1, max: 1 });
});

Deno.test('axes use the closed control set and render in order', () => {
  assertEquals(familyOf('kling').axes.map((a) => [a.id, a.control]), [
    ['aspectRatio', 'aspectRatio'],
    ['durationS', 'duration'],
    ['audio', 'choice'],
  ]);
  assertEquals(familyOf('gpt-image').axes.map((a) => a.id), ['version', 'aspectRatio', 'resolution', 'quality']);
});

Deno.test('flat prices are the fixed retail prices', () => {
  assertEquals(
    CATALOG.flat.editTools.map((t) => [t.id, t.credits]),
    [['edit-remove', 10], ['edit-fill', 10], ['edit-expand', 10], ['edit-bg', 5]],
  );
  assertEquals(CATALOG.flat.upscale.credits, 7);
  assertEquals(CATALOG.flat.persona.creditsPerImage, 46);
});

Deno.test('styles, trends and tool plans ride along as data', () => {
  assertEquals(CATALOG.styles.length, STYLE_PRESETS.length);
  assertEquals(CATALOG.styles[0], {
    id: STYLE_PRESETS[0].id,
    label: STYLE_PRESETS[0].name,
    category: STYLE_PRESETS[0].category,
    thumb: STYLE_PRESETS[0].thumb,
  });
  assertEquals(CATALOG.trends.length, TREND_PRESETS.length);
  assertEquals(CATALOG.trends[0].prompt, TREND_PRESETS[0].prompt);
  assertEquals(CATALOG.trends[0].thumb, TREND_PRESETS[0].thumb);
  assertEquals(CATALOG.toolPlans['bgremove'], 'pro');
  assertEquals(CATALOG.toolPlans['crop'], 'studio');
});
