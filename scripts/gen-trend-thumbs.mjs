// One-off: renders each trend template with a generic subject via GPT Image and
// writes PNGs to a temp dir. The thumb shows the trend's look — no trained
// persona needed. Post-process to webp like the style thumbs:
//   for f in <outDir>/*.png; do
//     cwebp -q 80 -resize 160 0 "$f" -o "public/trends/$(basename "${f%.png}").webp"
//   done
// Usage: OPENAI_API_KEY=... node scripts/gen-trend-thumbs.mjs <outDir>
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const outDir = process.argv[2];
if (!outDir) throw new Error('usage: node scripts/gen-trend-thumbs.mjs <outDir>');
const key = process.env.OPENAI_API_KEY;
if (!key) throw new Error('OPENAI_API_KEY not set');
mkdirSync(outDir, { recursive: true });

// Keep in sync with src/app/core/catalog/trend-presets.ts (ids + prompts).
const { TREND_PRESETS } = await import('../src/app/core/catalog/trend-presets.ts');

const SUBJECT = 'a friendly man in his early 30s with short dark hair';

for (const trend of TREND_PRESETS) {
  const out = join(outDir, `${trend.id}.png`);
  if (existsSync(out)) {
    console.log(`skip ${trend.id}.png (exists)`);
    continue;
  }
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: 'gpt-image-1',
      prompt: `${SUBJECT}, ${trend.prompt}`,
      size: '1024x1024',
      quality: 'low',
      n: 1,
    }),
  });
  if (!res.ok) throw new Error(`${trend.id}: ${res.status} ${await res.text()}`);
  const json = await res.json();
  const b64 = json.data?.[0]?.b64_json;
  if (!b64) throw new Error(`${trend.id}: no image in response`);
  writeFileSync(out, Buffer.from(b64, 'base64'));
  console.log(`generated ${trend.id}.png`);
}
