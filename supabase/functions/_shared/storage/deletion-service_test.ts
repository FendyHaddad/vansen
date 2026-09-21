import { assertEquals, assertRejects } from 'jsr:@std/assert';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { FakeDb, installRegistryRpcs } from '../testing/fakes.ts';
import { deleteObject, type DeleteDeps, drainDeletions, objectExists } from './deletion-service.ts';
import { enqueueDeletions, registerObject } from './registry.ts';
import type { StorageAdapter } from './types.ts';

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const R2_BUCKET = 'vansen-test';

/** An R2 adapter that records calls and can be told to misbehave. */
function fakeR2() {
  const objects = new Set<string>();
  const deletes: string[] = [];
  const state = {
    deleteError: null as string | null,
    existsError: null as string | null,
    /** Accept the delete but leave the object in place. */
    pretend: false,
  };
  const adapter: StorageAdapter = {
    backend: 'r2',
    put(path) {
      objects.add(path);
      return Promise.resolve();
    },
    signedUrl: (path) => Promise.resolve(`https://r2.test/${path}`),
    delete(path) {
      deletes.push(path);
      if (state.deleteError) return Promise.reject(new Error(state.deleteError));
      if (!state.pretend) objects.delete(path);
      return Promise.resolve();
    },
    exists(path) {
      if (state.existsError) return Promise.reject(new Error(state.existsError));
      return Promise.resolve(objects.has(path));
    },
  };
  return { adapter, objects, deletes, state };
}

function setup() {
  const db = new FakeDb();
  installRegistryRpcs(db);
  const r2 = fakeR2();
  const deps: DeleteDeps = {
    admin: db as unknown as SupabaseClient,
    r2Bucket: R2_BUCKET,
    r2: r2.adapter,
  };
  return { db, r2, deps };
}

/** Register, "write" and queue one Supabase object. Returns the outbox row id. */
async function queueSupabase(
  db: FakeDb,
  bucket: string,
  path: string,
): Promise<string> {
  const admin = db as unknown as SupabaseClient;
  const id = await registerObject(admin, {
    userId: USER,
    backend: 'supabase',
    bucket,
    path,
    purpose: bucket === 'uploads' ? 'upload' : 'media',
  });
  await db.storage.from(bucket).upload(path, new Uint8Array([1]), {
    contentType: 'image/png',
  });
  await enqueueDeletions(admin, [id], 'test');
  return id;
}

// ------------------------------------------------------------ the locator

Deno.test('a delete is aimed at one bucket, not one path', async () => {
  const { db, deps } = setup();
  await db.storage.from('uploads').upload(`${USER}/a.png`, new Uint8Array([1]), {
    contentType: 'image/png',
  });
  await db.storage.from('media').upload(`${USER}/a.png`, new Uint8Array([2]), {
    contentType: 'image/png',
  });

  await deleteObject(deps, { backend: 'supabase', bucket: 'uploads', path: `${USER}/a.png` });

  assertEquals(db.storage.objects.has(`uploads/${USER}/a.png`), false);
  assertEquals(
    db.storage.objects.has(`media/${USER}/a.png`),
    true,
    'the same key in another bucket is another object',
  );
});

Deno.test('an R2 row naming an unknown bucket is refused, not redirected', async () => {
  const { r2, deps } = setup();
  r2.objects.add('videos/x.mp4');

  await assertRejects(
    () => deleteObject(deps, { backend: 'r2', bucket: 'someone-elses', path: 'videos/x.mp4' }),
    Error,
    'unknown_r2_bucket',
  );
  assertEquals(r2.deletes.length, 0, 'nothing is deleted on a guess');
});

Deno.test('an incomplete locator is refused', async () => {
  const { deps } = setup();
  await assertRejects(
    () => deleteObject(deps, { backend: 'supabase', bucket: '', path: 'a.png' }),
    Error,
    'invalid_object_locator',
  );
  await assertRejects(
    () => deleteObject(deps, { backend: 'supabase', bucket: 'media', path: '' }),
    Error,
    'invalid_object_locator',
  );
});

Deno.test('a storage error on delete surfaces', async () => {
  const { db, deps } = setup();
  db.storage.failNext('media.remove', 'permission denied');
  await assertRejects(
    () => deleteObject(deps, { backend: 'supabase', bucket: 'media', path: 'a.png' }),
    Error,
    'object_delete_failed',
  );
});

// --------------------------------------------------------------- existence

Deno.test('a lookup that fails is not an absence', async () => {
  const { db, deps } = setup();
  db.storage.failNext('media.list', 'service unavailable');
  await assertRejects(
    () => objectExists(deps, { backend: 'supabase', bucket: 'media', path: `${USER}/a.png` }),
    Error,
    'object_lookup_failed',
  );
});

Deno.test('only the exact key counts as present', async () => {
  const { db, deps } = setup();
  await db.storage.from('media').upload(`${USER}/aa.png`, new Uint8Array([1]), {
    contentType: 'image/png',
  });

  // `aa.png` contains `a.png`: a substring listing must not pass for it.
  assertEquals(
    await objectExists(deps, { backend: 'supabase', bucket: 'media', path: `${USER}/a.png` }),
    false,
  );
  assertEquals(
    await objectExists(deps, { backend: 'supabase', bucket: 'media', path: `${USER}/aa.png` }),
    true,
  );
});

// ------------------------------------------------------------------- drain

Deno.test('a drained object is removed, proven gone and acknowledged once', async () => {
  const { db, deps } = setup();
  const objectId = await queueSupabase(db, 'media', `${USER}/g1.png`);

  const summary = await drainDeletions(deps);

  assertEquals(summary, { claimed: 1, deleted: 1, retried: 0, deadLettered: 0, stale: 0 });
  assertEquals(db.storage.objects.has(`media/${USER}/g1.png`), false);
  assertEquals(db.tables.storage_objects.find((o) => o.id === objectId)?.state, 'gone');
  assertEquals(db.tables.deletion_outbox[0].completed_at !== null, true);

  // Nothing is left to claim.
  assertEquals((await drainDeletions(deps)).claimed, 0);
});

Deno.test('a delete the backend accepted but did not perform is a retry', async () => {
  const { db, r2, deps } = setup();
  const admin = db as unknown as SupabaseClient;
  const id = await registerObject(admin, {
    userId: USER,
    backend: 'r2',
    bucket: R2_BUCKET,
    path: 'videos/v1.mp4',
    purpose: 'media',
  });
  r2.objects.add('videos/v1.mp4');
  await enqueueDeletions(admin, [id], 'test');
  r2.state.pretend = true;

  const summary = await drainDeletions(deps);

  assertEquals(summary.deleted, 0);
  assertEquals(summary.retried, 1);
  assertEquals(db.tables.storage_objects.find((o) => o.id === id)?.state, 'delete_pending');
  assertEquals(db.tables.deletion_outbox[0].completed_at, null);
  assertEquals(String(db.tables.deletion_outbox[0].last_error), 'object_still_present');
});

Deno.test('a lost response for a delete that DID land completes normally', async () => {
  const { db, r2, deps } = setup();
  const admin = db as unknown as SupabaseClient;
  const id = await registerObject(admin, {
    userId: USER,
    backend: 'r2',
    bucket: R2_BUCKET,
    path: 'videos/v2.mp4',
    purpose: 'media',
  });
  r2.objects.add('videos/v2.mp4');
  await enqueueDeletions(admin, [id], 'test');
  // The object goes, then the connection drops before the ack comes back.
  const original = r2.adapter.delete.bind(r2.adapter);
  r2.adapter.delete = async (path: string) => {
    await original(path);
    throw new Error('connection reset');
  };

  const summary = await drainDeletions(deps);

  assertEquals(summary.deleted, 1, 'the bytes are gone; the exception is not');
  assertEquals(db.tables.storage_objects.find((o) => o.id === id)?.state, 'gone');
});

Deno.test('a transient storage error keeps the row and backs it off', async () => {
  const { db, deps } = setup();
  await queueSupabase(db, 'media', `${USER}/g2.png`);
  db.storage.failNext('media.remove', '503 slow down');

  const summary = await drainDeletions(deps);

  assertEquals(summary.retried, 1);
  const row = db.tables.deletion_outbox[0];
  assertEquals(row.completed_at, null);
  assertEquals(row.attempts, 1);
  assertEquals(
    new Date(String(row.not_before)).getTime() > db.now().getTime(),
    true,
    'a failure waits before it is tried again',
  );
  assertEquals(db.storage.objects.has(`media/${USER}/g2.png`), true);
});

Deno.test('a verification the backend would not answer is a retry, not a deletion', async () => {
  const { db, deps } = setup();
  const objectId = await queueSupabase(db, 'media', `${USER}/g3.png`);
  db.storage.failNext('media.list', 'service unavailable');

  const summary = await drainDeletions(deps);

  assertEquals(summary.deleted, 0);
  assertEquals(summary.retried, 1);
  assertEquals(
    db.tables.storage_objects.find((o) => o.id === objectId)?.state,
    'delete_pending',
    'an object is only "gone" when we saw that it was',
  );
});

Deno.test('a worker whose lease expired cannot acknowledge another worker\'s object', async () => {
  const { db, deps } = setup();
  await queueSupabase(db, 'media', `${USER}/g4.png`);

  const claim = await db.rpc('fn_claim_deletions', { p_limit: 10 });
  const rows = claim.data as { id: string; lease_token: string }[];
  // Another worker takes over: the lease expires and is re-claimed.
  db.tables.deletion_outbox[0].lease_until = new Date(
    db.now().getTime() - 1000,
  ).toISOString();
  await db.rpc('fn_claim_deletions', { p_limit: 10 });

  const ack = await db.rpc('fn_complete_deletion', {
    p_id: rows[0].id,
    p_token: rows[0].lease_token,
    p_error: null,
  });

  assertEquals((ack.data as { acknowledged: boolean }).acknowledged, false);
  assertEquals(db.tables.deletion_outbox[0].completed_at, null);
  assertEquals(deps.r2Bucket, R2_BUCKET);
});

Deno.test('one bad object does not take the rest of the batch with it', async () => {
  const { db, deps } = setup();
  await queueSupabase(db, 'media', `${USER}/ok1.png`);
  await queueSupabase(db, 'uploads', `${USER}/bad.png`);
  await queueSupabase(db, 'media', `${USER}/ok2.png`);
  db.storage.failNext('uploads.remove', 'permission denied');

  const summary = await drainDeletions(deps);

  assertEquals(summary.claimed, 3);
  assertEquals(summary.deleted, 2);
  assertEquals(summary.retried, 1);
  assertEquals(db.storage.objects.has(`uploads/${USER}/bad.png`), true);
});

Deno.test('a stale acknowledgement is reported, never counted as a deletion', async () => {
  const { db, deps } = setup();
  await queueSupabase(db, 'media', `${USER}/g5.png`);
  // The row is completed by another worker between the claim and the ack.
  db.rpcHandlers.fn_complete_deletion = () => ({
    acknowledged: false,
    reason: 'stale_or_done',
  });

  const summary = await drainDeletions(deps);

  assertEquals(summary.deleted, 0);
  assertEquals(summary.stale, 1);
});

Deno.test('a spent retry budget dead-letters loudly instead of dropping the object', async () => {
  const { db, deps } = setup();
  const objectId = await queueSupabase(db, 'media', `${USER}/g6.png`);
  db.tables.deletion_outbox[0].attempts = 11;
  db.storage.failNext('media.remove', 'still broken');

  const summary = await drainDeletions(deps);

  assertEquals(summary.deadLettered, 1);
  const row = db.tables.deletion_outbox[0];
  assertEquals(row.completed_at, null, 'a dead letter is still owed');
  assertEquals(db.tables.storage_objects.find((o) => o.id === objectId)?.state, 'delete_pending');
});

Deno.test('a claim the database refuses is raised, not swallowed', async () => {
  const { db, deps } = setup();
  db.failNext('rpc.fn_claim_deletions', 'connection terminated');
  await assertRejects(() => drainDeletions(deps), Error, 'claim_deletions_failed');
});
