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

const missing = TREND_PRESETS
  .map((p) => ({ id: p.id, file: join(root, 'public', p.thumb) }))
  .filter((p) => !existsSync(p.file));

for (const m of missing) console.error(`MISSING ${m.file} (trend ${m.id})`);
console.log(
  `${TREND_PRESETS.length - missing.length}/${TREND_PRESETS.length} trend assets present`,
);
process.exit(missing.length ? 1 : 0);
