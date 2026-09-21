import { assertEquals } from 'jsr:@std/assert';
import { createApp } from './app.ts';
import { fakeAdapter, FakeDb, TEST_USER, testDeps } from './testing/fakes.ts';

const AUTH = { authorization: 'Bearer test-token' };

Deno.test('an unsupported resolution is refused before charge and before dispatch', async () => {
  const provider = fakeAdapter();
  const deps = testDeps({ adapterFor: () => provider.adapter });
  const db = deps.admin as unknown as FakeDb;
  db.tables.subscriptions = [
    { user_id: TEST_USER, plan: 'pro', status: 'active', current_period_end: '2099-01-01T00:00:00Z' },
  ];
  db.tables.models = [{ id: 'flux', enabled: true, min_plan: 'studio' }];
  db.rpcHandlers.fn_charge_and_generate = () => {
    throw new Error('charge must not be reached');
  };
  const app = createApp(deps);

  const res = await app.request('/api/generations', {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({
      op: 'generate',
      familyId: 'flux',
      prompt: 'a cat',
      batch: 1,
      settings: { aspectRatio: '1:1', resolution: '8MP' },
    }),
  });

  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.error.code, 'invalid_settings');
  assertEquals(body.error.message, 'FLUX does not offer resolution 8MP.');
  assertEquals(provider.submits.length, 0);
  assertEquals(db.rpcCalls.filter((r) => r.name === 'fn_charge_and_generate').length, 0);
});
