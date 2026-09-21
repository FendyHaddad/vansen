// A library row is a promise that the bytes are there. These prove the row is
// never marked `done` before that promise is kept, for both routes that write
// media outside the generation pipeline.
import { assertEquals } from 'jsr:@std/assert';
import { createApp } from './app.ts';
import { FakeDb, TEST_USER, testDeps } from './testing/fakes.ts';

const AUTH = { authorization: 'Bearer test-token' };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function subscribed(db: FakeDb) {
  db.tables.subscriptions = [
    { user_id: TEST_USER, plan: 'pro', status: 'active', current_period_end: '2099-01-01T00:00:00Z' },
  ];
}

function form(extra: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.append('file', new File([PNG], 'edit.png', { type: 'image/png' }));
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  return fd;
}

function withParent(db: FakeDb) {
  db.tables.generations = [
    { id: 'p0', user_id: TEST_USER, prompt: 'a cat', settings: {}, status: 'done', media_path: 'x.png' },
  ];
}

function mediaObjects(db: FakeDb): string[] {
  return [...db.storage.objects.keys()].filter((k) => k.startsWith('media/'));
}

for (
  const route of [
    { path: '/api/edits/save', body: () => form({ parentId: 'p0' }), seed: withParent },
    { path: '/api/library/import', body: () => form(), seed: (_db: FakeDb) => {} },
  ]
) {
  Deno.test(`${route.path} stores the object and only then marks the row done`, async () => {
    const deps = testDeps();
    const db = deps.admin as unknown as FakeDb;
    subscribed(db);
    route.seed(db);
    const app = createApp(deps);

    const res = await app.request(route.path, { method: 'POST', headers: AUTH, body: route.body() });

    assertEquals(res.status, 200);
    assertEquals((await res.json()).item.status, 'done');
    const saved = db.tables.generations.filter((g) => g.family_id === 'studio');
    assertEquals(saved.length, 1);
    assertEquals(saved[0].status, 'done');
    assertEquals(typeof saved[0].media_path, 'string');
    assertEquals(mediaObjects(db).length, 1);
  });

  Deno.test(`${route.path} inserts the row pending, never done`, async () => {
    const deps = testDeps();
    const db = deps.admin as unknown as FakeDb;
    subscribed(db);
    route.seed(db);
    const inserted: Record<string, unknown>[] = [];
    const realFrom = db.from.bind(db);
    db.from = ((table: string) => {
      const q = realFrom(table);
      if (table !== 'generations') return q;
      const insert = q.insert.bind(q);
      q.insert = ((payload: Record<string, unknown>) => {
        inserted.push(payload);
        return insert(payload);
      }) as typeof q.insert;
      return q;
    }) as typeof db.from;
    const app = createApp(deps);

    await app.request(route.path, { method: 'POST', headers: AUTH, body: route.body() });

    // Inserting `done` up front is the original defect: a crash between the
    // insert and the upload leaves a library row pointing at nothing.
    assertEquals(inserted.length, 1);
    assertEquals(inserted[0].status, 'pending');
  });

  Deno.test(`${route.path} returns 503 and leaves nothing behind when the final update errors`, async () => {
    const deps = testDeps();
    const db = deps.admin as unknown as FakeDb;
    subscribed(db);
    route.seed(db);
    db.failNext('generations.update', 'connection reset');
    const app = createApp(deps);

    const res = await app.request(route.path, { method: 'POST', headers: AUTH, body: route.body() });

    assertEquals(res.status, 503);
    assertEquals((await res.json()).error.code, 'save_failed');
    assertEquals(db.tables.generations.filter((g) => g.family_id === 'studio'), []);
    assertEquals(mediaObjects(db), [], 'the staged object must not outlive the row');
  });

  Deno.test(`${route.path} returns 503 when the final update matches no row`, async () => {
    const deps = testDeps();
    const db = deps.admin as unknown as FakeDb;
    subscribed(db);
    route.seed(db);
    const app = createApp(deps);
    // A zero-row update is the other race: something else removed the staged
    // row while the bytes were being written. It must read as a failure, never
    // as a silent success.
    const realFrom = db.from.bind(db);
    db.from = ((table: string) => {
      const q = realFrom(table);
      if (table !== 'generations') return q;
      const update = q.update.bind(q);
      q.update = ((payload: Record<string, unknown>) => {
        if (payload.status === 'done') {
          db.tables.generations = db.tables.generations.filter((g) => g.family_id !== 'studio');
        }
        return update(payload);
      }) as typeof q.update;
      return q;
    }) as typeof db.from;

    const res = await app.request(route.path, { method: 'POST', headers: AUTH, body: route.body() });

    assertEquals(res.status, 503);
    assertEquals((await res.json()).error.code, 'save_failed');
    assertEquals(db.tables.generations.filter((g) => g.family_id === 'studio'), []);
    assertEquals(mediaObjects(db), []);
  });
}
