// The gateway's half of durable deletion: what a customer's delete request
// actually does, and what it is allowed to claim.
import { assertEquals } from 'jsr:@std/assert';
import { createApp } from './app.ts';
import { FakeDb, TEST_USER, testDeps } from './testing/fakes.ts';
import type { ApiDeps } from './app.ts';

const AUTH = { authorization: 'Bearer test-token' };
const GEN = 'gggggggg-0000-4000-8000-000000000001';
const PERSONA = 'pppppppp-0000-4000-8000-000000000001';

interface StripeSub {
  id: string;
  status: string;
}

/** Records what the closure actually asked Stripe to do. */
function fakeStripe(subs: StripeSub[], opts: { listFails?: boolean } = {}) {
  const cancelled: string[] = [];
  const stripe = {
    subscriptions: {
      list: (args: { customer: string; status: string }) => {
        if (opts.listFails) return Promise.reject(new Error('stripe down'));
        return Promise.resolve({ data: subs, listedWith: args.status });
      },
      cancel: (id: string) => {
        cancelled.push(id);
        const hit = subs.find((s) => s.id === id)!;
        hit.status = 'canceled';
        return Promise.resolve(hit);
      },
    },
  } as unknown as ApiDeps['stripe'];
  return { stripe, cancelled };
}

/** The subscriptions the closure actually recorded. */
function closureSubs(db: FakeDb): { source: string; action: string }[] {
  return (db.tables.account_deletions[0].subscriptions ?? []) as {
    source: string;
    action: string;
  }[];
}

function seedGeneration(db: FakeDb, over: Record<string, unknown> = {}): void {
  db.tables.generations = [{
    id: GEN,
    user_id: TEST_USER,
    kind: 'image',
    family_id: 'flux',
    family_name: 'FLUX',
    op: 'generate',
    prompt: 'a cat',
    settings: {},
    price_credits: 40,
    status: 'done',
    media_path: `${TEST_USER}/${GEN}.png`,
    thumb_path: null,
    storage_backend: 'supabase',
    deleted_at: null,
    ...over,
  }];
  db.tables.storage_objects.push({
    id: 'obj-gen',
    user_id: TEST_USER,
    backend: 'supabase',
    bucket: 'media',
    path: `${TEST_USER}/${GEN}.png`,
    purpose: 'media',
    state: 'live',
    retain_until: null,
  });
}

function app(over: Partial<ApiDeps> = {}) {
  const deps = testDeps(over);
  const db = deps.admin as unknown as FakeDb;
  return { app: createApp(deps), db };
}

// ------------------------------------------------------------- generations

Deno.test('deleting a finished generation queues its bytes and hides the row', async () => {
  const { app: api, db } = app();
  seedGeneration(db);

  const res = await api.request(`/api/generations/${GEN}`, {
    method: 'DELETE',
    headers: AUTH,
  });

  assertEquals(res.status, 202);
  assertEquals(await res.json(), { status: 'accepted', objectsQueued: 1 });
  assertEquals(db.tables.generations.length, 0);
  assertEquals(db.tables.deletion_outbox[0].object_path, `${TEST_USER}/${GEN}.png`);
  assertEquals(db.tables.deletion_outbox[0].bucket, 'media');
  // The gateway does not touch storage: a best-effort delete here is exactly
  // what left bytes nobody could name.
  assertEquals(db.tables.deletion_outbox[0].completed_at, null);
});

Deno.test('deleting a running generation asks it to stop and keeps the row', async () => {
  const { app: api, db } = app();
  seedGeneration(db, { status: 'pending' });
  db.tables.jobs = [{
    id: 'job-1',
    user_id: TEST_USER,
    generation_id: GEN,
    state: 'submitted',
    provider: 'fal',
    cancel_requested_at: null,
  }];

  const res = await api.request(`/api/generations/${GEN}`, {
    method: 'DELETE',
    headers: AUTH,
  });

  assertEquals(res.status, 202);
  assertEquals((await res.json()).status, 'processing');
  assertEquals(db.tables.generations[0].deleted_at !== null, true);
  assertEquals(db.tables.jobs[0].cancel_requested_at !== null, true);
  assertEquals(db.tables.jobs[0].state, 'submitted', 'only the lease holder settles a job');
  assertEquals(db.tables.deletion_outbox.length, 0, 'the provider may still send bytes');
});

Deno.test('a deleted generation is gone from every read path', async () => {
  const { app: api, db } = app();
  seedGeneration(db, { status: 'pending' });
  db.tables.jobs = [{
    id: 'job-1',
    user_id: TEST_USER,
    generation_id: GEN,
    state: 'submitted',
    provider: 'fal',
    cancel_requested_at: null,
  }];
  await api.request(`/api/generations/${GEN}`, { method: 'DELETE', headers: AUTH });

  const list = await (await api.request('/api/generations', { headers: AUTH })).json();
  const cancel = await api.request(`/api/jobs/${GEN}/cancel`, {
    method: 'POST',
    headers: AUTH,
  });

  assertEquals(list.items, []);
  assertEquals(cancel.status, 404);
});

Deno.test('asking twice is the same request, not an error', async () => {
  const { app: api, db } = app();
  seedGeneration(db, { status: 'pending' });
  db.tables.jobs = [{
    id: 'job-1',
    user_id: TEST_USER,
    generation_id: GEN,
    state: 'submitted',
    provider: 'fal',
    cancel_requested_at: null,
  }];

  const first = await api.request(`/api/generations/${GEN}`, { method: 'DELETE', headers: AUTH });
  const second = await api.request(`/api/generations/${GEN}`, { method: 'DELETE', headers: AUTH });

  assertEquals(first.status, 202);
  assertEquals(second.status, 202);
  assertEquals((await second.json()).status, 'processing');
  assertEquals(db.tables.deletion_outbox.length, 0);
});

Deno.test('a late provider output is captured and then queued, not stranded', async () => {
  const { app: api, db } = app();
  seedGeneration(db, { status: 'pending', media_path: null });
  db.tables.jobs = [{
    id: 'job-1',
    user_id: TEST_USER,
    generation_id: GEN,
    state: 'submitted',
    provider: 'fal',
    cancel_requested_at: null,
  }];
  await api.request(`/api/generations/${GEN}`, { method: 'DELETE', headers: AUTH });

  // The provider could not be cancelled and finished anyway: the worker
  // registers the object and settles the job onto the tombstoned row.
  db.tables.storage_objects.push({
    id: 'obj-late',
    user_id: TEST_USER,
    backend: 'supabase',
    bucket: 'media',
    path: `${TEST_USER}/${GEN}.png`,
    purpose: 'media',
    state: 'live',
    retain_until: null,
  });
  db.tables.generations[0].media_path = `${TEST_USER}/${GEN}.png`;
  db.tables.generations[0].status = 'done';
  db.tables.jobs[0].state = 'done';

  // The reaper picks the tombstone up on its next pass.
  const reaped = await db.rpc('fn_delete_generation', {
    p_user: TEST_USER,
    p_id: GEN,
  });

  assertEquals((reaped.data as { status: string }).status, 'queued');
  assertEquals(db.tables.deletion_outbox[0].object_path, `${TEST_USER}/${GEN}.png`);
});

Deno.test('another customer\'s generation is not deletable', async () => {
  const { app: api, db } = app();
  seedGeneration(db, { user_id: 'someone-else' });

  const res = await api.request(`/api/generations/${GEN}`, {
    method: 'DELETE',
    headers: AUTH,
  });

  assertEquals(res.status, 404);
  assertEquals(db.tables.deletion_outbox.length, 0);
});

// ---------------------------------------------------------------- personas

Deno.test('deleting a persona queues its photos and records no provider artifact', async () => {
  const { app: api, db } = app();
  db.tables.personas = [{
    id: PERSONA,
    user_id: TEST_USER,
    name: 'Ada',
    status: 'ready',
    photos: {
      front: `${TEST_USER}/photo-1.png`,
      left_three_quarter: null,
      right_three_quarter: null,
      left_profile: null,
      right_profile: null,
    },
    deleted_at: null,
  }];
  db.tables.storage_objects.push({
    id: 'obj-photo',
    user_id: TEST_USER,
    backend: 'supabase',
    bucket: 'uploads',
    path: `${TEST_USER}/photo-1.png`,
    purpose: 'persona-photo',
    state: 'live',
    retain_until: null,
  });

  const res = await api.request(`/api/personas/${PERSONA}`, {
    method: 'DELETE',
    headers: AUTH,
  });

  assertEquals(res.status, 202);
  assertEquals(db.tables.deletion_outbox[0].bucket, 'uploads');
  assertEquals((db.tables.provider_artifact_deletions ?? []).length, 0);
});

// ---------------------------------------------------------------- closure

Deno.test('closure cancels every subscription that can still bill', async () => {
  const { stripe, cancelled } = fakeStripe([
    { id: 'sub_active', status: 'active' },
    { id: 'sub_trialing', status: 'trialing' },
    { id: 'sub_past_due', status: 'past_due' },
    { id: 'sub_unpaid', status: 'unpaid' },
    { id: 'sub_incomplete', status: 'incomplete' },
    { id: 'sub_paused', status: 'paused' },
    { id: 'sub_canceled', status: 'canceled' },
    { id: 'sub_expired', status: 'incomplete_expired' },
  ]);
  const { app: api, db } = app({ stripe });
  db.tables.profiles[0].stripe_customer_id = 'cus_1';

  const res = await api.request('/api/profile', { method: 'DELETE', headers: AUTH });
  const body = await res.json();

  assertEquals(res.status, 202);
  assertEquals(cancelled, [
    'sub_active',
    'sub_trialing',
    'sub_past_due',
    'sub_unpaid',
    'sub_incomplete',
    'sub_paused',
  ]);
  assertEquals(body.subscriptions.length, 8);
  assertEquals(
    body.subscriptions.filter((s: { action: string }) => s.action === 'already_final').length,
    2,
    'a subscription that is already finished is recorded, not cancelled again',
  );
  assertEquals(closureSubs(db).length, 8);
});

Deno.test('a Stripe we cannot reach stops the closure instead of guessing', async () => {
  const { stripe } = fakeStripe([{ id: 'sub_active', status: 'active' }], { listFails: true });
  const { app: api, db } = app({ stripe });
  db.tables.profiles[0].stripe_customer_id = 'cus_1';

  const res = await api.request('/api/profile', { method: 'DELETE', headers: AUTH });

  assertEquals(res.status, 503);
  assertEquals((await res.json()).error.code, 'delete_failed');
  assertEquals(db.tables.account_deletions ?? [], []);
  assertEquals(db.tables.profiles.length, 1, 'nothing is deleted around a live subscription');
});

Deno.test('an App Store subscription is recorded with the only action that works', async () => {
  const { stripe } = fakeStripe([]);
  const { app: api, db } = app({ stripe });
  db.tables.subscriptions = [{
    user_id: TEST_USER,
    plan: 'pro',
    status: 'active',
    iap_original_transaction_id: '2000000012345678',
  }];

  const body = await (await api.request('/api/profile', {
    method: 'DELETE',
    headers: AUTH,
  })).json();

  assertEquals(body.appleAction, 'manage_in_app_store');
  assertEquals(body.subscriptions[0].source, 'apple');
  assertEquals(body.subscriptions[0].id, '2000000012345678');
  assertEquals(closureSubs(db)[0].action, 'manage_in_app_store');
});

Deno.test('closure removes the auth user once the data side is finalised', async () => {
  const { stripe } = fakeStripe([]);
  const { app: api, db } = app({ stripe });
  seedGeneration(db);

  const body = await (await api.request('/api/profile', {
    method: 'DELETE',
    headers: AUTH,
  })).json();

  assertEquals(body.status, 'processing');
  assertEquals(db.deletedUsers, [TEST_USER]);
  assertEquals(db.tables.account_deletions[0].status, 'completed');
  assertEquals(db.tables.profiles.length, 0);
});

Deno.test('closure with work still running leaves the account to the worker', async () => {
  const { stripe } = fakeStripe([]);
  const { app: api, db } = app({ stripe });
  seedGeneration(db, { status: 'pending' });
  db.tables.jobs = [{
    id: 'job-1',
    user_id: TEST_USER,
    generation_id: GEN,
    state: 'submitted',
    provider: 'fal',
    cancel_requested_at: null,
  }];

  const body = await (await api.request('/api/profile', {
    method: 'DELETE',
    headers: AUTH,
  })).json();

  assertEquals(body.pendingJobs, 1);
  assertEquals(db.deletedUsers, [], 'the sign-in outlives nothing but the running job');
  assertEquals(db.tables.profiles.length, 1);
  assertEquals(db.tables.generations[0].deleted_at !== null, true);
  assertEquals(db.tables.jobs[0].cancel_requested_at !== null, true);
});

Deno.test('closure is not completed while a provider still holds a derived model', async () => {
  const { stripe } = fakeStripe([]);
  const { app: api, db } = app({ stripe });
  db.tables.provider_artifact_deletions = [{
    id: 'art-1',
    user_id: TEST_USER,
    provider: 'fal',
    artifact_ref: 'https://fal.example/lora/ada.safetensors',
    status: 'requested',
  }];

  const body = await (await api.request('/api/profile', {
    method: 'DELETE',
    headers: AUTH,
  })).json();

  assertEquals(body.providerArtifacts, 1);
  assertEquals(db.deletedUsers, [TEST_USER], 'the customer\'s own data still goes');
  assertEquals(
    db.tables.account_deletions[0].status,
    'processing',
    'a closure with a live third-party copy is not finished',
  );
});

Deno.test('asking to close twice reuses the same closure', async () => {
  const { stripe } = fakeStripe([]);
  const { app: api, db } = app({ stripe });
  seedGeneration(db, { status: 'pending' });
  db.tables.jobs = [{
    id: 'job-1',
    user_id: TEST_USER,
    generation_id: GEN,
    state: 'submitted',
    provider: 'fal',
    cancel_requested_at: null,
  }];

  const first = await (await api.request('/api/profile', { method: 'DELETE', headers: AUTH }))
    .json();
  const second = await (await api.request('/api/profile', { method: 'DELETE', headers: AUTH }))
    .json();

  assertEquals(first.requestId, second.requestId);
  assertEquals(db.tables.account_deletions.length, 1);
});
