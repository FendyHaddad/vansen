// One-off: renders the same base subject in each style preset via GPT Image and
// writes PNGs to a temp dir.
// Usage: OPENAI_API_KEY=... node scripts/gen-style-thumbs.mjs <outDir>
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const outDir = process.argv[2];
if (!outDir) throw new Error('usage: node scripts/gen-style-thumbs.mjs <outDir>');
const key = process.env.OPENAI_API_KEY;
if (!key) throw new Error('OPENAI_API_KEY not set');
mkdirSync(outDir, { recursive: true });

// Keep in sync with src/app/core/catalog/style-presets.ts (ids + modifiers).
const { STYLE_PRESETS } = await import('../src/app/core/catalog/style-presets.ts');

const BASE_PROMPT =
  'a young woman with a red scarf holding a lantern in a misty forest clearing at dusk';

for (const style of STYLE_PRESETS) {
  const out = join(outDir, `${style.id}.png`);
  if (existsSync(out)) {
    console.log(`skip ${style.id}.png (exists)`);
    continue;
  }
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: 'gpt-image-1',
      prompt: `${BASE_PROMPT}, ${style.modifier}`,
      size: '1024x1024',
      quality: 'low',
      n: 1,
    }),
  });
  if (!res.ok) throw new Error(`${style.id}: ${res.status} ${await res.text()}`);
  const json = await res.json();
  const b64 = json.data?.[0]?.b64_json;
  if (!b64) throw new Error(`${style.id}: no image in response`);
  writeFileSync(out, Buffer.from(b64, 'base64'));
  console.log(`generated ${style.id}.png`);
}
