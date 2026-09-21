import { assertEquals, assertRejects } from 'jsr:@std/assert';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { FakeDb, TEST_USER } from '../testing/fakes.ts';
import { type PayloadDeps, resolvePayload, type StoredPayload } from './payload.ts';
import type { StorageAdapter } from '../storage/index.ts';

const REF = `${TEST_USER}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png`;
const REF2 = `${TEST_USER}/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.png`;
const MASK = `${TEST_USER}/cccccccc-cccc-4ccc-8ccc-cccccccccccc.png`;
const MASK_BYTES = new Uint8Array([1, 2, 3]);

function upload(path: string, purpose: string): Record<string, unknown> {
  // Exactly the registry shape P1 introduced.
  return {
    id: crypto.randomUUID(), user_id: TEST_USER, path, purpose,
    mime: 'image/png', bytes: 1024, width: 512, height: 512, moderation: 'allowed',
  };
}

interface Harness {
  db: FakeDb;
  deps: PayloadDeps;
  r2: string[];
  /** Moves the wall clock the signed URLs are stamped against. */
  clock: { now: number };
}

function harness(): Harness {
  const db = new FakeDb();
  db.tables.uploads = [upload(REF, 'reference'), upload(REF2, 'reference'), upload(MASK, 'mask')];
  db.tables.generations = [];
  db.tables.personas = [];
  const clock = { now: 1_000 };
  const r2: string[] = [];
  // Signed URLs carry their expiry, so a stale one is visibly different from a
  // freshly minted one.
  const realStorage = db.storage.from.bind(db.storage);
  db.storage.from = ((bucket: string) => {
    const api = realStorage(bucket);
    const sign = api.createSignedUrl.bind(api);
    api.createSignedUrl = (async (path: string, ttl: number) => {
      const res = await sign(path, ttl);
      if (res.error) return res;
      return {
        data: { signedUrl: `https://fake.storage/${bucket}/${path}?exp=${clock.now + ttl}` },
        error: null,
      };
    }) as typeof api.createSignedUrl;
    return api;
  }) as typeof db.storage.from;
  for (const path of [REF, REF2, MASK]) {
    db.storage.objects.set(`uploads/${path}`, {
      bytes: MASK_BYTES,
      contentType: 'image/png',
    });
  }
  return {
    db,
    clock,
    r2,
    deps: {
      admin: db as unknown as SupabaseClient,
      storageFor: () =>
        ({
          signedUrl: (path: string, ttl: number) => {
            r2.push(path);
            return Promise.resolve(`https://fake.r2/${path}?exp=${clock.now + ttl}`);
          },
        }) as unknown as StorageAdapter,
      signTtlS: 3600,
    },
  };
}

function job(payload: Partial<StoredPayload>): {
  id: string;
  user_id: string;
  generation_id: string;
  payload: Record<string, unknown>;
} {
  return {
    id: 'j0',
    user_id: TEST_USER,
    generation_id: 'g0',
    payload: {
      familyId: 'flux', op: 'generate', prompt: 'a cat', settings: { aspectRatio: '1:1' },
      providerModel: 'fal-ai/flux-2',
      providerSettings: { image_size: { width: 1024, height: 1024 } },
      quoteVersion: 1, catalogVersion: '2026-09-20.2', safetyId: 'sid',
      ...payload,
    } as unknown as Record<string, unknown>,
  };
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

Deno.test('the stored quote travels to the adapter unchanged', async () => {
  const h = harness();
  const ctx = await resolvePayload(h.deps, job({}));
  assertEquals(ctx.normalized?.providerModel, 'fal-ai/flux-2');
  assertEquals(ctx.normalized?.catalogVersion, '2026-09-20.2');
  assertEquals(ctx.prompt, 'a cat');
});

Deno.test('a deferred job re-signs its reference instead of reusing a dead URL', async () => {
  const h = harness();
  const first = await resolvePayload(h.deps, job({ referenceUploadId: REF }));

  // The job waits in the queue past the lifetime of that URL.
  h.clock.now += 7_200;
  const second = await resolvePayload(h.deps, job({ referenceUploadId: REF }));

  assertEquals(typeof first.referenceUrl, 'string');
  assertEquals(first.referenceUrl === second.referenceUrl, false, 'a new URL must be minted');
  const expiry = Number(new URL(second.referenceUrl!).searchParams.get('exp'));
  assertEquals(expiry > h.clock.now, true, 'the fresh URL must outlive the moment it is used');
});

Deno.test('a reference deleted after submission fails before any provider call', async () => {
  const h = harness();
  h.db.tables.uploads = h.db.tables.uploads.filter((u) => u.path !== REF);
  await assertRejects(
    () => resolvePayload(h.deps, job({ referenceUploadId: REF })),
    Error,
    'reference_not_found',
  );
});

Deno.test('another owner upload is never signed', async () => {
  const h = harness();
  const foreign = '22222222-2222-4222-8222-222222222222/dddddddd-dddd-4ddd-8ddd-dddddddddddd.png';
  h.db.tables.uploads.push({ ...upload(foreign, 'reference'), user_id: 'someone-else' });
  await assertRejects(
    () => resolvePayload(h.deps, job({ referenceUploadId: foreign })),
    Error,
    'reference_not_owned',
  );
});

Deno.test('an upload stored for another purpose is refused', async () => {
  const h = harness();
  await assertRejects(
    // The mask upload is not a reference, however much its path looks like one.
    () => resolvePayload(h.deps, job({ referenceUploadId: MASK })),
    Error,
    'reference_wrong_purpose',
  );
});

Deno.test('keyframes keep first/last order', async () => {
  const h = harness();
  const ctx = await resolvePayload(
    h.deps,
    job({ mode: 'keyframes', referenceSlots: { first: REF, last: REF2 } }),
  );
  assertEquals(ctx.referenceUrls?.length, 2);
  assertEquals(ctx.referenceUrls![0].includes(REF), true, 'first slot first');
  assertEquals(ctx.referenceUrls![1].includes(REF2), true, 'last slot last');
});

Deno.test('ref2v slots are signed in their stored order', async () => {
  const h = harness();
  const ctx = await resolvePayload(
    h.deps,
    job({ mode: 'ref2v', referenceSlots: { references: [REF2, REF] } }),
  );
  assertEquals(ctx.referenceUrls![0].includes(REF2), true);
  assertEquals(ctx.referenceUrls![1].includes(REF), true);
});

Deno.test('a mask is read from storage as bytes, never carried in the payload', async () => {
  const h = harness();
  const ctx = await resolvePayload(h.deps, job({ maskUploadId: MASK }));
  assertEquals(ctx.maskPngBase64, base64(MASK_BYTES));
  assertEquals(ctx.normalized?.hasMask, true);
});

Deno.test('a parent image is signed from its own backend', async () => {
  const h = harness();
  h.db.tables.generations = [
    { id: 'p0', user_id: TEST_USER, kind: 'image', status: 'done', media_path: 'u/p0.png', storage_backend: 'supabase', settings: {} },
  ];
  h.db.storage.objects.set('media/u/p0.png', { bytes: MASK_BYTES, contentType: 'image/png' });
  const ctx = await resolvePayload(h.deps, job({ op: 'edit', parentId: 'p0' }));
  assertEquals(ctx.referenceUrl?.includes('media/u/p0.png'), true);
});

Deno.test('a parent video is signed from r2 and carries its interaction id', async () => {
  const h = harness();
  h.db.tables.generations = [
    { id: 'p1', user_id: TEST_USER, kind: 'video', status: 'done', media_path: 'videos/u/p1.mp4', storage_backend: 'r2', settings: { interactionId: 'omni-7' } },
  ];
  const ctx = await resolvePayload(
    h.deps,
    job({ familyId: 'omni', mode: 'extend', parentId: 'p1' }),
  );
  assertEquals(h.r2, ['videos/u/p1.mp4']);
  assertEquals(ctx.parentVideoUrl?.startsWith('https://fake.r2/'), true);
  assertEquals(ctx.interactionId, 'omni-7');
});

Deno.test('a parent that is no longer finished fails before dispatch', async () => {
  const h = harness();
  h.db.tables.generations = [
    { id: 'p0', user_id: TEST_USER, kind: 'image', status: 'pending', media_path: null, storage_backend: 'supabase', settings: {} },
  ];
  await assertRejects(
    () => resolvePayload(h.deps, job({ op: 'edit', parentId: 'p0' })),
    Error,
    'parent_not_ready',
  );
});

Deno.test('a persona that is no longer ready fails before dispatch', async () => {
  const h = harness();
  h.db.tables.personas = [
    { id: 'per0', user_id: TEST_USER, status: 'failed', lora_url: null },
  ];
  await assertRejects(
    () => resolvePayload(h.deps, job({ personaId: 'per0' })),
    Error,
    'persona_not_ready',
  );
});

Deno.test('a ready persona contributes its provider-hosted LoRA', async () => {
  const h = harness();
  h.db.tables.personas = [
    { id: 'per1', user_id: TEST_USER, status: 'ready', lora_url: 'https://fal.run/lora/1' },
  ];
  const ctx = await resolvePayload(h.deps, job({ personaId: 'per1' }));
  assertEquals(ctx.loraUrl, 'https://fal.run/lora/1');
});
