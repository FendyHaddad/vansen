#!/usr/bin/env node
// Owner-run: does the persona setup beat normal use? Same prompt, both 4K.
//   persona: five slot photos + the identity instruction
//   normal:  the front photo alone + the plain prompt
// Costs about $0.52. Needs GOOGLE_AI_API_KEY. Usage:
//   npm run persona:likeness -- <dir with front.jpg left_three_quarter.jpg
//                                right_three_quarter.jpg left_profile.jpg right_profile.jpg>
// Writes <dir>/likeness-persona.{jpg,png} and <dir>/likeness-normal.{jpg,png},
// named from the type Gemini returns. Compare them
// by eye; a clear gain sets PERSONA_GEN.premium in model-families.ts.
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { buildGeminiRequest, callGemini } from './generate-persona-guides.mjs';

const SLOTS = ['front', 'left_three_quarter', 'right_three_quarter', 'left_profile', 'right_profile'];
export const LIKENESS_PROMPT =
  'A candid photo of this person reading a book in a sunlit café, natural expression.';
// Verbatim from supabase/functions/api/personas.ts personaPrompt(), so the
// likeness test's persona arm matches production's identity instruction.
const IDENTITY = 'Images 1–5 are the same person (front, left three-quarter, right three-quarter, ' +
  'left profile, right profile). Keep their face and identity exactly. ';

const EXTENSION = { 'image/jpeg': 'jpg', 'image/png': 'png' };

/** The output name for one arm, from the mime Gemini returned. */
export function likenessFile(arm, mime) {
  const ext = EXTENSION[mime];
  if (!ext) throw new Error(`likeness ${arm}: unexpected image type ${mime} from Gemini`);
  return `likeness-${arm}.${ext}`;
}

export function likenessRequests(photos) {
  const persona = buildGeminiRequest({
    prompt: IDENTITY + LIKENESS_PROMPT,
    images: photos.map((p, i) => ({ label: `Image ${i + 1}: ${SLOTS[i].replaceAll('_', ' ')}`, ...p })),
    imageSize: '4K', aspectRatio: '3:4',
  });
  const normal = buildGeminiRequest({
    prompt: LIKENESS_PROMPT,
    images: [{ label: 'Reference photo', ...photos[0] }],
    imageSize: '4K', aspectRatio: '3:4',
  });
  return { persona, normal };
}

async function main() {
  const dir = process.argv[2];
  if (!dir) throw new Error('usage: npm run persona:likeness -- <photos-dir>');
  const photos = [];
  for (const slot of SLOTS) {
    const bytes = await readFile(`${dir}/${slot}.jpg`);
    photos.push({ mime: 'image/jpeg', base64: bytes.toString('base64') });
  }
  const { persona, normal } = likenessRequests(photos);
  const a = await callGemini(persona);
  const aName = likenessFile('persona', a.mime);
  await writeFile(`${dir}/${aName}`, Buffer.from(a.base64, 'base64'));
  const b = await callGemini(normal);
  const bName = likenessFile('normal', b.mime);
  await writeFile(`${dir}/${bName}`, Buffer.from(b.base64, 'base64'));
  console.log(`wrote ${aName} and ${bName}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
