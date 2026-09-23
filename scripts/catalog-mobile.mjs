// Writes the GET /catalog payload, with the models table exactly as the
// migrations seed it, to the path given. Mobile bundles this file so a fresh
// install renders a real catalog before its first network call.
//
//   npm run catalog:mobile /Users/user/StudioProjects/vansen-mobile/assets/catalog/catalog.json
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { buildCatalog } = await import(join(root, 'src/app/core/catalog/build-catalog.ts'));

// 0001/0005/0008/0013/0016/0032/0034: image families, the upscaler and the
// edit tools (Pro since 0034) ship on; video (Pro) and persona ship off.
const SEED_MODEL_ROWS = [
  { id: 'nano-banana', enabled: true, min_plan: 'studio' },
  { id: 'gpt-image', enabled: true, min_plan: 'studio' },
  { id: 'flux', enabled: true, min_plan: 'studio' },
  { id: 'seedream', enabled: true, min_plan: 'studio' },
  { id: 'upscaler', enabled: true, min_plan: 'studio' },
  { id: 'edit-remove', enabled: true, min_plan: 'pro' },
  { id: 'edit-fill', enabled: true, min_plan: 'pro' },
  { id: 'edit-expand', enabled: true, min_plan: 'pro' },
  { id: 'edit-bg', enabled: true, min_plan: 'pro' },
  { id: 'veo', enabled: false, min_plan: 'pro' },
  { id: 'omni', enabled: false, min_plan: 'pro' },
  { id: 'kling', enabled: false, min_plan: 'pro' },
  { id: 'runway', enabled: false, min_plan: 'pro' },
  { id: 'seedance', enabled: false, min_plan: 'pro' },
  { id: 'persona', enabled: false, min_plan: 'studio' },
];

const outPath = process.argv[2];
if (!outPath) {
  console.error('usage: npm run catalog:mobile <outPath>');
  process.exit(1);
}
const target = resolve(process.cwd(), outPath);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify(buildCatalog(SEED_MODEL_ROWS), null, 2)}\n`);
console.log(`wrote ${target}`);
