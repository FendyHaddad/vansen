#!/usr/bin/env node
// Every asset path referenced by the catalog must exist on disk. A 404'd
// thumbnail is invisible in a unit test — the DOM is identical either way —
// and unmissable to a customer, who sees a grid of broken-image icons.
//
//   npm run check:assets
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { TREND_PRESETS } = await import(join(root, 'src/app/core/catalog/trend-presets.ts'));
const { STYLE_PRESETS } = await import(join(root, 'src/app/core/catalog/style-presets.ts'));

function checkAssets(label, presets) {
  const missing = presets
    .map((p) => ({ id: p.id, file: join(root, 'public', p.thumb) }))
    .filter((p) => !existsSync(p.file));
  for (const m of missing) console.error(`MISSING ${m.file} (${label} ${m.id})`);
  console.log(`${presets.length - missing.length}/${presets.length} ${label} assets present`);
  return missing.length;
}

const missingCount = checkAssets('trend', TREND_PRESETS) + checkAssets('style', STYLE_PRESETS);
process.exit(missingCount ? 1 : 0);
