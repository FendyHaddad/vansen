import { assertEquals } from 'jsr:@std/assert';
import { buildCatalog, IMAGE_BATCH_MAX } from './_shared/build-catalog.ts';
import {
  familyById,
  PERSONA_MAX_BYTES,
  PERSONA_MIN_EDGE,
  PERSONA_NAME_MAX,
  PERSONA_SLOT_LABELS,
  PERSONA_SLOT_ORDER,
  PERSONA_SLOTS,
  personaGenCreditCost,
  personaSettings,
} from './_shared/model-families.ts';
import { validateSettings } from './services/request-validation.ts';

const PERSONA = buildCatalog([{ id: 'persona', enabled: true, min_plan: 'studio' }]).flat.persona;
const MIGRATIONS = new URL('../../migrations/', import.meta.url);
const SEED_FILE = '0020_durable_dispatch.sql';

async function migrationTexts(): Promise<Map<string, string>> {
  const texts = new Map<string, string>();
  for await (const entry of Deno.readDir(MIGRATIONS)) {
    if (!entry.name.endsWith('.sql')) continue;
    texts.set(entry.name, await Deno.readTextFile(new URL(entry.name, MIGRATIONS)));
  }
  return texts;
}

Deno.test('flat.persona carries the constants the gateway enforces', () => {
  assertEquals(PERSONA.creditsPerImage, personaGenCreditCost());
  assertEquals(PERSONA.enabled, true);
  assertEquals(PERSONA.photoSlots, PERSONA_SLOT_ORDER.map((id) => ({ id, label: PERSONA_SLOT_LABELS[id] })));
  assertEquals(PERSONA.minEdge, PERSONA_MIN_EDGE);
  assertEquals(PERSONA.maxBytes, PERSONA_MAX_BYTES);
  assertEquals(PERSONA.maxNameLength, PERSONA_NAME_MAX);
  assertEquals(PERSONA.planSlots, PERSONA_SLOTS);
  assertEquals(PERSONA.batch, { min: 1, max: IMAGE_BATCH_MAX });
});

Deno.test('flat.persona publishes the values the spec names', () => {
  assertEquals(PERSONA.photoSlots.map((s) => s.label), ['Front', 'Left ¾', 'Right ¾', 'Left profile', 'Right profile']);
  assertEquals([PERSONA.minEdge, PERSONA.maxBytes, PERSONA.maxNameLength], [1024, 2621440, 40]);
  assertEquals(PERSONA.planSlots, { studio: 2, pro: 5, owner: 5 });
  assertEquals(PERSONA.aspectRatios, ['1:1', '3:4', '4:3', '16:9', '9:16']);
});

Deno.test('a listed ratio passes the gateway persona check; an unlisted Nano Banana ratio fails it', () => {
  const nano = familyById('nano-banana');
  if (!nano) throw new Error('nano-banana missing');
  for (const ratio of nano.capabilities.aspectRatios) {
    const accepted = validateSettings(nano, personaSettings(ratio)) === null;
    assertEquals(PERSONA.aspectRatios.includes(ratio), accepted, ratio);
  }
});

Deno.test('planSlots equals the persona_slots seed in dispatch_limits', async () => {
  const texts = await migrationTexts();
  const seed = texts.get(SEED_FILE) ?? '';
  const seeded = Object.fromEntries(
    [...seed.matchAll(/\('persona_slots:(\w+)',\s*(\d+)\)/g)].map((m) => [m[1], Number(m[2])]),
  );
  assertEquals(seeded, PERSONA.planSlots);
  const laterWrites = [...texts]
    .filter(([name, sql]) => name !== SEED_FILE && /persona_slots:(studio|pro|owner)/.test(sql))
    .map(([name]) => name);
  assertEquals(laterWrites, [], 'a later migration writes persona_slots: extend this guard to read it');
});
