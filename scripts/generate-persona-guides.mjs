#!/usr/bin/env node
// Owner-run, once: draws the fictional person shown in the five empty persona
// slots. Costs under $1 at 1K. Needs GOOGLE_AI_API_KEY in the environment.
// Output: public/personas/guides/{slot}.jpg (commit them afterwards).
//
// Request shape mirrors supabase/functions/_shared/providers/google.ts
// (googleAdapter.submit) exactly: same base URL/version path, same
// x-goog-api-key header, same inline_data/mime_type field names, same
// snake_case imageConfig keys, and the same trailing `safetySettings: []`.
// That file is Deno-only (Deno.env, jsr imports) so its constants are
// duplicated here rather than imported.
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const MODEL = 'gemini-3-pro-image'; // provider-capabilities.json nanoModels.pro
const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const PERSON = 'a fictional adult woman in her thirties, shoulder-length dark hair, ' +
  'neutral grey t-shirt, plain light-grey studio background, soft even lighting, ' +
  'natural skin texture, photorealistic';

export const GUIDE_PROMPTS = {
  front: `Head-and-shoulders photo of ${PERSON}, facing the camera directly.`,
  left_three_quarter: `Head-and-shoulders photo of ${PERSON}, head turned 45 degrees to her left.`,
  right_three_quarter: `Head-and-shoulders photo of ${PERSON}, head turned 45 degrees to her right.`,
  left_profile: `Head-and-shoulders photo of ${PERSON}, full left profile, 90 degrees.`,
  right_profile: `Head-and-shoulders photo of ${PERSON}, full right profile, 90 degrees.`,
};

const GUIDE_DIR = 'public/personas/guides';

/** Where a slot's guide photo goes. Gemini returns JPEG; anything else is refused
 * rather than written under a name that lies about its type. */
export function guidePath(slot, mime) {
  if (mime !== 'image/jpeg') {
    throw new Error(`guide ${slot}: expected image/jpeg from Gemini, got ${mime}`);
  }
  return `${GUIDE_DIR}/${slot}.jpg`;
}

export function buildGeminiRequest({ prompt, images, imageSize, aspectRatio }) {
  const parts = [];
  for (const image of images) {
    parts.push({ text: image.label });
    parts.push({ inline_data: { mime_type: image.mime, data: image.base64 } });
  }
  parts.push({ text: prompt });
  return {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseModalities: ['IMAGE'],
      imageConfig: { image_size: imageSize, aspect_ratio: aspectRatio },
    },
    safetySettings: [],
  };
}

export async function callGemini(body) {
  const key = process.env.GOOGLE_AI_API_KEY;
  if (!key) throw new Error('GOOGLE_AI_API_KEY is not set');
  const res = await fetch(`${BASE}/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`gemini ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const part = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData ?? p.inline_data);
  const inline = part?.inlineData ?? part?.inline_data;
  if (!inline?.data) throw new Error('gemini returned no image');
  console.log(JSON.stringify({ event: 'google_usage', usage: data.usageMetadata ?? null }));
  return { mime: inline.mimeType ?? inline.mime_type, base64: inline.data };
}

async function main() {
  await mkdir(GUIDE_DIR, { recursive: true });
  const front = await callGemini(buildGeminiRequest({
    prompt: GUIDE_PROMPTS.front, images: [], imageSize: '1K', aspectRatio: '3:4',
  }));
  await writeFile(guidePath('front', front.mime), Buffer.from(front.base64, 'base64'));
  for (const [slot, prompt] of Object.entries(GUIDE_PROMPTS)) {
    if (slot === 'front') continue;
    const image = await callGemini(buildGeminiRequest({
      prompt: `Same person as the reference image. ${prompt}`,
      images: [{ label: 'Reference: the same person, front', ...front }],
      imageSize: '1K', aspectRatio: '3:4',
    }));
    await writeFile(guidePath(slot, image.mime), Buffer.from(image.base64, 'base64'));
    console.log(`wrote ${slot}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
