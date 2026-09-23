import { assert, assertEquals } from 'jsr:@std/assert';
import { createApp } from './app.ts';
import { FakeDb, TEST_USER, testDeps } from './testing/fakes.ts';

// GET /jobs is how a client learns its pending work settled. An empty 200 on a
// database failure reads as "those jobs are gone", so the client drops them.
// A failed read must say it failed.

const AUTH = { authorization: 'Bearer test-token' };

function seed(db: FakeDb) {
  db.tables.generations = [{
    id: 'g1', user_id: TEST_USER, kind: 'image', family_id: 'flux', op: 'generate',
    prompt: 'a cat', settings: {}, price_credits: 4, status: 'pending',
    media_path: null, storage_backend: 'supabase', deleted_at: null,
  }];
  db.tables.jobs = [{
    id: 'j1', user_id: TEST_USER, generation_id: 'g1', progress: 10, phase: 'running',
    claimed_at: null, created_at: '2026-09-23T00:00:00Z', queue_position: null,
  }];
}

for (const table of ['generations', 'jobs']) {
  Deno.test(`GET /jobs: a failed ${table} read is a 5xx, not an empty list`, async () => {
    const deps = testDeps();
    const db = deps.admin as unknown as FakeDb;
    seed(db);
    db.failNext(`${table}.select`, 'connection lost');

    const res = await createApp(deps).request('/api/jobs?ids=g1', { headers: AUTH });
    assertEquals(res.status, 503, await res.clone().text());
    const body = await res.json();
    assertEquals(body.error.code, 'jobs_unavailable');
    assertEquals(body.items, undefined, 'no list a client could mistake for the truth');

    await new Promise((r) => setTimeout(r, 0));
    const logged = (db.tables.app_errors ?? []).find((r) => r.code === 'jobs_read_failed');
    assert(logged, 'the failure is recorded in app_errors');
    assertEquals(logged.message, 'connection lost');
  });
}

Deno.test('GET /jobs: a healthy read still lists the pending item', async () => {
  const deps = testDeps();
  const db = deps.admin as unknown as FakeDb;
  seed(db);
  const res = await createApp(deps).request('/api/jobs?ids=g1', { headers: AUTH });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.items.length, 1);
  assertEquals(body.items[0].id, 'g1');
});
