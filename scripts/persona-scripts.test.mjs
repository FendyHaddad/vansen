import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGeminiRequest, GUIDE_PROMPTS, guidePath } from './generate-persona-guides.mjs';
import { likenessFile, likenessRequests } from './persona-likeness-test.mjs';

test('guide prompts cover the five slots, one fictional adult', () => {
  assert.deepEqual(Object.keys(GUIDE_PROMPTS), [
    'front', 'left_three_quarter', 'right_three_quarter', 'left_profile', 'right_profile',
  ]);
  for (const p of Object.values(GUIDE_PROMPTS)) assert.match(p, /fictional adult/);
});

test('a gemini request puts labelled images before the prompt', () => {
  const body = buildGeminiRequest({
    prompt: 'go', imageSize: '4K', aspectRatio: '3:4',
    images: [{ label: 'Image 1: front', mime: 'image/jpeg', base64: 'AA' }],
  });
  const parts = body.contents[0].parts;
  assert.equal(parts[0].text, 'Image 1: front');
  assert.equal(parts[1].inline_data.mime_type, 'image/jpeg');
  assert.equal(parts[2].text, 'go');
  assert.deepEqual(body.generationConfig.imageConfig, { image_size: '4K', aspect_ratio: '3:4' });
});

test('the gemini request body matches the production adapter shape', () => {
  const body = buildGeminiRequest({
    prompt: 'go', imageSize: '1K', aspectRatio: '3:4', images: [],
  });
  assert.equal(body.contents[0].role, 'user');
  assert.deepEqual(body.generationConfig.responseModalities, ['IMAGE']);
  assert.deepEqual(body.safetySettings, []);
});

test('the likeness test sends 5 photos to the persona arm and 1 to the normal arm', () => {
  const photos = ['a', 'b', 'c', 'd', 'e'].map((b) => ({ mime: 'image/jpeg', base64: b }));
  const { persona, normal } = likenessRequests(photos);
  const count = (body) => body.contents[0].parts.filter((p) => p.inline_data).length;
  assert.equal(count(persona), 5);
  assert.equal(count(normal), 1);
  assert.match(persona.contents[0].parts.at(-1).text, /same person/);
  assert.doesNotMatch(normal.contents[0].parts.at(-1).text, /same person/);
});

test('the likeness persona identity instruction matches personas.ts personaPrompt verbatim', () => {
  const photos = ['a', 'b', 'c', 'd', 'e'].map((b) => ({ mime: 'image/jpeg', base64: b }));
  const { persona } = likenessRequests(photos);
  const promptText = persona.contents[0].parts.at(-1).text;
  assert.match(
    promptText,
    /^Images 1–5 are the same person \(front, left three-quarter, right three-quarter, left profile, right profile\)\. Keep their face and identity exactly\. /,
  );
});

test('persona photo labels use "Image N: <slot with spaces>"', () => {
  const photos = ['a', 'b', 'c', 'd', 'e'].map((b) => ({ mime: 'image/jpeg', base64: b }));
  const { persona } = likenessRequests(photos);
  const labels = persona.contents[0].parts.filter((p) => p.text && /^Image \d+:/.test(p.text));
  assert.deepEqual(labels.map((p) => p.text), [
    'Image 1: front',
    'Image 2: left three quarter',
    'Image 3: right three quarter',
    'Image 4: left profile',
    'Image 5: right profile',
  ]);
});

test('guide photos are written as .jpg, the type Gemini returns', () => {
  assert.equal(guidePath('front', 'image/jpeg'), 'public/personas/guides/front.jpg');
  assert.equal(guidePath('left_profile', 'image/jpeg'), 'public/personas/guides/left_profile.jpg');
});

test('a guide photo that is not JPEG is refused, naming the mime', () => {
  assert.throws(() => guidePath('front', 'image/png'), /image\/png/);
  assert.throws(() => guidePath('front', undefined), /undefined/);
});

test('likeness outputs are named from the returned mime', () => {
  assert.equal(likenessFile('persona', 'image/jpeg'), 'likeness-persona.jpg');
  assert.equal(likenessFile('normal', 'image/png'), 'likeness-normal.png');
  assert.throws(() => likenessFile('normal', 'image/webp'), /image\/webp/);
});
