import { assertEquals, assert } from 'jsr:@std/assert';
import { SNAPSHOT_VERSION, captureSnapshot, rehydrate } from './request-snapshot.ts';

const base = {
  op: 'generate' as const,
  familyId: 'flux',
  prompt: 'a cat',
  settings: { aspectRatio: '1:1', resolution: '1MP' },
  referenceUploadIds: [],
  referenceSlots: { first: null, last: null, references: [] },
  maskUploadId: null,
  personaId: null,
  styleId: null,
  trendId: null,
  mode: null,
  parentId: null,
  catalogVersion: 'cat-v1', quoteVersion: 1,
};

Deno.test('a snapshot carries its version', () => {
  assertEquals(captureSnapshot(base).version, SNAPSHOT_VERSION);
});

Deno.test('R15: a mask is recorded by object path, not by data URI', () => {
  const snap = captureSnapshot({ ...base, op: 'edit', familyId: 'edit-fill', maskUploadId: 'u/masks/1.png' });
  assertEquals(snap.maskUploadId, 'u/masks/1.png');
  assert(!JSON.stringify(snap).includes('data:'), 'a megabyte data URI must not live in the snapshot');
});

Deno.test('R15: references are recorded by upload id', () => {
  const snap = captureSnapshot({ ...base, referenceUploadIds: ['up-1', 'up-2'] });
  assertEquals(snap.referenceUploadIds, ['up-1', 'up-2']);
});

Deno.test('R15: NO signed url survives into a snapshot', () => {
  // Signed URLs expire in 7 days. A snapshot holding one is a retry that
  // works this week and fails next week for no visible reason.
  // The gateway hands over a normalized request, which is WIDER than the
  // snapshot: it still holds the resolved signed URLs it just used.
  const snap = captureSnapshot({
    ...base,
    referenceSlots: { first: 'up-1', last: null, references: [] },
    referenceUrls: ['https://x.supabase.co/object/sign/media/u/ref.png?token=abc'],
    maskPngBase64: 'data:image/png;base64,AAAA',
  } as never);
  const json = JSON.stringify(snap);
  assert(!json.includes('token='), json);
  assert(!json.includes('/sign/'), json);
});

Deno.test('R15: persona and style are first-class, not smuggled through settings', () => {
  const snap = captureSnapshot({ ...base, personaId: 'p-1', styleId: 'cinematic', trendId: '90s-yearbook' });
  assertEquals(snap.personaId, 'p-1');
  assertEquals(snap.styleId, 'cinematic');
  assertEquals(snap.trendId, '90s-yearbook');
});

Deno.test('R15: a persona generation records the real family, not "persona"', () => {
  // Items were stored with familyId='persona', so a retry sent that as the
  // model family and got invalid_family.
  const snap = captureSnapshot({ ...base, familyId: 'flux', personaId: 'p-1' });
  assertEquals(snap.familyId, 'flux');
  assertEquals(snap.personaId, 'p-1');
});

Deno.test('a video keyframe snapshot keeps slot ORDER', () => {
  const snap = captureSnapshot({
    ...base, familyId: 'kling', mode: 'keyframes',
    referenceUploadIds: ['first-frame', 'last-frame'],
  });
  assertEquals(snap.referenceUploadIds, ['first-frame', 'last-frame']);
});

Deno.test('rehydrate refuses a version it does not understand', () => {
  const result = rehydrate({ ...captureSnapshot(base), version: 99 } as never);
  assertEquals(result.ok, false);
  assert(!result.ok);
  assertEquals(result.reason, 'unsupported_version');
});

Deno.test('rehydrate refuses a snapshot from a superseded catalog', () => {
  // A price or a provider model changed. Replaying the old request at the new
  // price is a surprise charge; replaying at the old price is a loss.
  const result = rehydrate({ ...captureSnapshot(base), catalogVersion: 'cat-v0' }, 'cat-v1');
  assertEquals(result.ok, false);
  assert(!result.ok);
  assertEquals(result.reason, 'catalog_changed');
});

Deno.test('a round trip through JSON changes nothing', () => {
  const snap = captureSnapshot({ ...base, referenceUploadIds: ['a'], personaId: 'p' });
  assertEquals(JSON.parse(JSON.stringify(snap)), snap);
});
