// Review I3: a retried request (same Idempotency-Key, same body) is answered
// from its first outcome BEFORE moderation runs, so a flagged prompt whose
// response was lost never records a second strike (2 strikes suspend). A
// changed body under the same key is still refused, never waved through.
import { assert, assertEquals } from 'jsr:@std/assert';
import { createApp } from './app.ts';
import type { ApiDeps } from './app.ts';
import type { ModerationDecision } from './_shared/moderation.ts';
import { FakeDb, TEST_USER, testDeps } from './testing/fakes.ts';
import { callTool, jsonOf, mcpApp } from './testing/mcp.ts';

const AUTH = { authorization: 'Bearer test-token' };
const KEY = 'b3b1f2a0-0000-4000-8000-0000000000a1';
const BLOCKED: ModerationDecision = { state: 'blocked', categories: { violence: 0.99 } };

/** Moderation that answers `decide()` every time and counts its calls. */
function scriptedModeration(decide: () => ModerationDecision) {
  const calls: unknown[] = [];
  const moderate: ApiDeps['moderate'] = (input) => {
    calls.push(input);
    return Promise.resolve(decide());
  };
  return { calls, moderate };
}

function ready(db: FakeDb) {
  db.tables.subscriptions = [
    { user_id: TEST_USER, plan: 'pro', status: 'active', current_period_end: '2099-01-01T00:00:00Z' },
  ];
  db.tables.models = [{ id: 'flux', enabled: true, min_plan: 'studio' }];
  db.tables.notification_outbox = [];
  db.tables.moderation_events = [];
}

function setup(decide: () => ModerationDecision) {
  const moderation = scriptedModeration(decide);
  const deps = testDeps({ moderate: moderation.moderate });
  const db = deps.admin as unknown as FakeDb;
  ready(db);
  return { app: createApp(deps), db, moderation };
}

function generate(prompt = 'something bad') {
  return JSON.stringify({
    op: 'generate',
    familyId: 'flux',
    prompt,
    batch: 1,
    settings: { aspectRatio: '1:1', resolution: '1MP' },
  });
}

function post(body: string, key?: string) {
  const headers: Record<string, string> = { ...AUTH, 'content-type': 'application/json' };
  if (key) headers['Idempotency-Key'] = key;
  return { method: 'POST', headers, body };
}

function strikes(db: FakeDb): number {
  return db.rpcCalls.filter((c) => c.name === 'fn_increment_strike').length;
}

Deno.test('a flagged request retried with the same key gets the same refusal and no second strike', async () => {
  const { app, db, moderation } = setup(() => BLOCKED);

  const first = await app.request('/api/generations', post(generate(), KEY));
  const retry = await app.request('/api/generations', post(generate(), KEY));

  assertEquals(first.status, 422);
  assertEquals((await first.json()).error.code, 'content_policy');
  assertEquals(retry.status, 422);
  assertEquals((await retry.json()).error.code, 'content_policy');
  assertEquals(strikes(db), 1);
  assertEquals(db.tables.moderation_events.length, 1);
  assertEquals(moderation.calls.length, 1, 'the retry is answered before moderation');
});

Deno.test('the key of a refused request cannot carry a different body past moderation', async () => {
  const { app, db, moderation } = setup(() => BLOCKED);

  await app.request('/api/generations', post(generate(), KEY));
  const changed = await app.request('/api/generations', post(generate('a cat'), KEY));

  assertEquals(changed.status, 409);
  assertEquals((await changed.json()).error.code, 'idempotency_conflict');
  assertEquals(moderation.calls.length, 1);
  assertEquals(strikes(db), 1);
  assertEquals(db.rpcCalls.filter((c) => c.name === 'fn_reserve_generation').length, 0);
});

Deno.test('an accepted request retried with the same key replays without a second moderation call', async () => {
  let decision: ModerationDecision = { state: 'allowed' };
  const { app, db, moderation } = setup(() => decision);

  const first = await app.request('/api/generations', post(generate('a cat'), KEY));
  assertEquals(first.status, 202);
  const firstIds = (await first.json()).items.map((i: { id: string }) => i.id);

  // Even a moderation model that now flags the same text cannot strike a replay.
  decision = BLOCKED;
  const retry = await app.request('/api/generations', post(generate('a cat'), KEY));

  assertEquals(retry.status, 202);
  assertEquals((await retry.json()).items.map((i: { id: string }) => i.id), firstIds);
  assertEquals(moderation.calls.length, 1);
  assertEquals(strikes(db), 0);
  assertEquals(db.tables.generations.length, 1, 'charged once');
});

Deno.test('an accepted key reused with a different body is refused before moderation', async () => {
  const { app, db, moderation } = setup(() => ({ state: 'allowed' }));

  await app.request('/api/generations', post(generate('a cat'), KEY));
  const changed = await app.request('/api/generations', post(generate('a dog'), KEY));

  assertEquals(changed.status, 409);
  assertEquals((await changed.json()).error.code, 'idempotency_conflict');
  assertEquals(moderation.calls.length, 1);
  assertEquals(db.tables.generations.length, 1);
});

Deno.test('two flagged requests racing on one key record one strike', async () => {
  const { app, db } = setup(() => BLOCKED);
  // The other request's refusal record landed between our read and our write.
  db.failNext('submissions.insert', 'duplicate key value violates unique constraint', '23505');

  const res = await app.request('/api/generations', post(generate(), KEY));

  assertEquals(res.status, 422);
  assertEquals(strikes(db), 0, 'the request that won the record struck');
});

Deno.test('without a key every flagged request is new and strikes (unchanged)', async () => {
  const { app, db } = setup(() => BLOCKED);
  await app.request('/api/generations', post(generate()));
  await app.request('/api/generations', post(generate()));
  assertEquals(strikes(db), 2);
});

// ── MCP: generate_image derives its key from the JSON-RPC id and arguments ──

function mcpSetup(decide: () => ModerationDecision) {
  const moderation = scriptedModeration(decide);
  const made = mcpApp({ moderate: moderation.moderate, sleep: () => Promise.resolve() });
  ready(made.db);
  made.db.tables.models = [{ id: 'flux', enabled: true, min_plan: 'studio' }];
  return { ...made, moderation };
}

Deno.test('MCP: a flagged generate_image retried with the same request id strikes once', async () => {
  const { app, db, moderation } = mcpSetup(() => BLOCKED);

  const first = await callTool(app, 'generate_image', { prompt: 'something bad', model: 'flux' }, { id: 77 });
  const retry = await callTool(app, 'generate_image', { prompt: 'something bad', model: 'flux' }, { id: 77 });

  assert(first.isError);
  assert(retry.isError);
  assertEquals(jsonOf(first).error, 'content_policy');
  assertEquals(jsonOf(retry).error, 'content_policy');
  assertEquals(moderation.calls.length, 1);
  assertEquals(strikes(db), 1);
});

Deno.test('MCP: a caller idempotency_key replays a refusal without a second strike', async () => {
  const { app, db } = mcpSetup(() => BLOCKED);
  const args = { prompt: 'something bad', model: 'flux', idempotency_key: 'call-1' };

  await callTool(app, 'generate_image', args, { id: 1 });
  const retry = await callTool(app, 'generate_image', args, { id: 2 });

  assertEquals(jsonOf(retry).error, 'content_policy');
  assertEquals(strikes(db), 1);
});
