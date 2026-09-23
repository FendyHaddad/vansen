import { assertEquals } from 'jsr:@std/assert';
import { createApp } from './app.ts';
import { fakeAdapter, FakeDb, TEST_USER, testDeps } from './testing/fakes.ts';
import { CATALOG_VERSION } from './_shared/model-families.ts';
import { isStaleCatalog } from './catalog.ts';

const AUTH = { authorization: 'Bearer test-token' };
const OLD = '2026-01-01.1';

function ready() {
  const provider = fakeAdapter();
  const deps = testDeps({ adapterFor: () => provider.adapter });
  const db = deps.admin as unknown as FakeDb;
  db.tables.subscriptions = [
    { user_id: TEST_USER, plan: 'pro', status: 'active', current_period_end: '2099-01-01T00:00:00Z' },
  ];
  db.tables.models = [{ id: 'flux', enabled: true, min_plan: 'studio' }];
  return createApp(deps);
}

function submit(app: ReturnType<typeof createApp>, extra: Record<string, unknown>) {
  return app.request('/api/generations', {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'generate', familyId: 'flux', prompt: 'a cat', batch: 1, ...extra }),
  });
}

Deno.test('an old catalog asking for an option that is gone gets 409 catalog_stale', async () => {
  const res = await submit(ready(), { catalogVersion: OLD, settings: { aspectRatio: '16:9', resolution: '4MP' } });
  assertEquals(res.status, 409);
  const body = await res.json();
  assertEquals(body.error.code, 'catalog_stale');
  assertEquals(body.error.message, 'The model options changed. Pick again.');
});

Deno.test('the current catalog asking for an invalid option is still a 400', async () => {
  const res = await submit(ready(), {
    catalogVersion: CATALOG_VERSION,
    settings: { aspectRatio: '16:9', resolution: '4MP' },
  });
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error.code, 'invalid_settings');
});

Deno.test('no catalog version keeps the 400', async () => {
  const res = await submit(ready(), { settings: { aspectRatio: '16:9', resolution: '4MP' } });
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error.code, 'invalid_settings');
});

Deno.test('valid settings from an old catalog are served normally', async () => {
  const res = await submit(ready(), { catalogVersion: OLD, settings: { aspectRatio: '1:1', resolution: '1MP' } });
  assertEquals(res.status, 202);
  await res.body?.cancel();
});

Deno.test('a reference an old catalog thought FLUX takes is catalog_stale', async () => {
  const res = await submit(ready(), {
    catalogVersion: OLD,
    settings: { aspectRatio: '1:1', resolution: '1MP' },
    referenceUploadId: `${TEST_USER}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png`,
  });
  assertEquals(res.status, 409);
  assertEquals((await res.json()).error.code, 'catalog_stale');
});

Deno.test('a family an old catalog still lists is catalog_stale', async () => {
  const res = await submit(ready(), { catalogVersion: OLD, familyId: 'sora', settings: { aspectRatio: '16:9' } });
  assertEquals(res.status, 409);
  assertEquals((await res.json()).error.code, 'catalog_stale');
});

Deno.test('only a non-empty, different string is stale', () => {
  assertEquals(isStaleCatalog(OLD), true);
  assertEquals(isStaleCatalog(CATALOG_VERSION), false);
  assertEquals(isStaleCatalog(''), false);
  assertEquals(isStaleCatalog(undefined), false);
  assertEquals(isStaleCatalog(7), false);
});
