import { assert, assertEquals, assertNotEquals } from 'jsr:@std/assert';
import { createApp } from './app.ts';
import { FakeDb, testDeps } from './testing/fakes.ts';
import { CATALOG_VERSION } from './_shared/model-families.ts';
import { CATALOG_CACHE_CONTROL, catalogEtag, etagMatches } from './catalog.ts';

function appWith(rows: { id: string; enabled: boolean; min_plan: string }[]) {
  const deps = testDeps();
  const db = deps.admin as unknown as FakeDb;
  db.tables.models = rows;
  return { app: createApp(deps), db };
}

Deno.test('catalog is public and carries the version, etag and cache policy', async () => {
  const { app } = appWith([{ id: 'nano-banana', enabled: true, min_plan: 'studio' }]);
  const res = await app.request('/api/catalog');
  assertEquals(res.status, 200);
  assertEquals(res.headers.get('cache-control'), CATALOG_CACHE_CONTROL);
  const etag = res.headers.get('etag') ?? '';
  assert(etag.startsWith(`"${CATALOG_VERSION}-`), etag);
  const body = await res.json();
  assertEquals(body.catalogVersion, CATALOG_VERSION);
  const nano = body.families.find((f: { id: string }) => f.id === 'nano-banana');
  assertEquals(nano.enabled, true);
  const flux = body.families.find((f: { id: string }) => f.id === 'flux');
  assertEquals(flux.enabled, false);
});

Deno.test('a matching If-None-Match gets 304 with no body', async () => {
  const { app } = appWith([{ id: 'flux', enabled: true, min_plan: 'studio' }]);
  const first = await app.request('/api/catalog');
  const etag = first.headers.get('etag') ?? '';
  await first.body?.cancel();

  const again = await app.request('/api/catalog', { headers: { 'if-none-match': etag } });
  assertEquals(again.status, 304);
  assertEquals(await again.text(), '');
  assertEquals(again.headers.get('etag'), etag);

  const weak = await app.request('/api/catalog', { headers: { 'if-none-match': `"x", W/${etag}` } });
  assertEquals(weak.status, 304);
  await weak.body?.cancel();
});

Deno.test('flipping a kill switch changes the etag and the payload', async () => {
  const { app, db } = appWith([{ id: 'flux', enabled: true, min_plan: 'studio' }]);
  const before = await app.request('/api/catalog');
  const etag = before.headers.get('etag') ?? '';
  await before.body?.cancel();

  db.tables.models[0].enabled = false;
  const after = await app.request('/api/catalog', { headers: { 'if-none-match': etag } });
  assertEquals(after.status, 200);
  assertNotEquals(after.headers.get('etag'), etag);
  const body = await after.json();
  assertEquals(body.families.find((f: { id: string }) => f.id === 'flux').enabled, false);
});

Deno.test('a models read failure is a 503 with an incident id', async () => {
  const { app, db } = appWith([]);
  db.failNext('models.select', 'connection lost');
  const res = await app.request('/api/catalog');
  assertEquals(res.status, 503);
  const body = await res.json();
  assertEquals(body.error.code, 'catalog_unavailable');
  assertEquals(typeof body.error.errorId, 'string');
});

Deno.test('a models read failure is logged under the errorId it returns', async () => {
  const { app, db } = appWith([]);
  db.failNext('models.select', 'connection lost');
  const res = await app.request('/api/catalog');
  const { error } = await res.json();
  assert(error.errorId.length > 0, 'no quotable id');
  assertEquals(res.headers.get('x-request-id'), error.errorId);
  await new Promise((r) => setTimeout(r, 0));
  const logged = (db.tables.app_errors ?? []).find((r) => r.request_id === error.errorId);
  assert(logged, `no app_errors row for ${error.errorId}`);
  assertEquals(logged.code, 'catalog_unavailable');
  assertEquals(logged.route, '/api/catalog');
  assertEquals(logged.message, 'connection lost');
});

Deno.test('the etag ignores row order and reflects plan changes', () => {
  const a = { id: 'flux', enabled: true, min_plan: 'studio' };
  const b = { id: 'veo', enabled: false, min_plan: 'pro' };
  assertEquals(catalogEtag([a, b]), catalogEtag([b, a]));
  assertNotEquals(catalogEtag([a]), catalogEtag([{ ...a, min_plan: 'pro' }]));
});

Deno.test('the etag hex segment is always 8 chars, even when the hash is small', () => {
  const pattern = /^"[^"]+-[0-9a-f]{8}"$/;
  const rowSets: { id: string; enabled: boolean; min_plan: string }[][] = [
    [],
    [{ id: 'flux', enabled: true, min_plan: 'studio' }],
    [{ id: 'veo', enabled: false, min_plan: 'pro' }],
    [
      { id: 'flux', enabled: true, min_plan: 'studio' },
      { id: 'veo', enabled: false, min_plan: 'pro' },
    ],
  ];
  for (const rows of rowSets) {
    const etag = catalogEtag(rows);
    assert(pattern.test(etag), etag);
  }
});

Deno.test('If-None-Match matching handles lists, weak tags and wildcards', () => {
  assert(etagMatches('"v-1"', '"v-1"'));
  assert(etagMatches('"a", W/"v-1"', '"v-1"'));
  assert(etagMatches('*', '"v-1"'));
  assertEquals(etagMatches(undefined, '"v-1"'), false);
  assertEquals(etagMatches('"v-2"', '"v-1"'), false);
});
