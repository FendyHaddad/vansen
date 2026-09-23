import { assert, assertEquals } from 'jsr:@std/assert';
import { createApp } from './app.ts';
import { FakeDb, TEST_USER, testDeps } from './testing/fakes.ts';

// GET /ledger feeds the usage tab. A database failure is the server's fault,
// not the client's: a 400 hid it from the logs and told clients the request
// was malformed. A failed read is a 5xx and is recorded.

const AUTH = { authorization: 'Bearer test-token' };

function seed(db: FakeDb) {
  db.tables.ledger_entries = [{
    id: 'l1', user_id: TEST_USER, type: 'spend', amount_credits: -4, bucket: 'plan',
    family_id: 'flux', note: null, created_at: '2026-09-23T00:00:00Z',
  }];
}

Deno.test('GET /ledger: a failed read is a logged 5xx, not a 400', async () => {
  const deps = testDeps();
  const db = deps.admin as unknown as FakeDb;
  seed(db);
  db.failNext('ledger_entries.select', 'connection lost');

  const res = await createApp(deps).request('/api/ledger', { headers: AUTH });
  assertEquals(res.status, 503, await res.clone().text());
  const body = await res.json();
  assertEquals(body.error.code, 'ledger_unavailable');
  assertEquals(body.entries, undefined, 'no list a client could mistake for the truth');

  await new Promise((r) => setTimeout(r, 0));
  const logged = (db.tables.app_errors ?? []).find((r) => r.code === 'ledger_read_failed');
  assert(logged, 'the failure is recorded in app_errors');
  assertEquals(logged.message, 'connection lost');
});

Deno.test('GET /ledger: a healthy read still lists the entry', async () => {
  const deps = testDeps();
  const db = deps.admin as unknown as FakeDb;
  seed(db);
  const res = await createApp(deps).request('/api/ledger', { headers: AUTH });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.entries.length, 1);
  assertEquals(body.entries[0].id, 'l1');
});
