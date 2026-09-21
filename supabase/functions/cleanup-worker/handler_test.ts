import { assertEquals } from 'jsr:@std/assert';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { FakeDb, installRegistryRpcs } from './_shared/testing/fakes.ts';
import { registerObject } from './_shared/storage/registry.ts';
import { enqueueDeletions } from './_shared/storage/registry.ts';
import type { StorageAdapter } from './_shared/storage/types.ts';
import { type CleanupDeps, createCleanupWorker, runCleanupTick } from './handler.ts';

const SECRET = 'cleanup-secret';
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const deadR2: StorageAdapter = {
  backend: 'r2',
  put: () => Promise.reject(new Error('not used')),
  signedUrl: () => Promise.reject(new Error('not used')),
  delete: () => Promise.reject(new Error('not used')),
  exists: () => Promise.reject(new Error('not used')),
};

function setup(over: Partial<CleanupDeps> = {}) {
  const db = new FakeDb();
  installRegistryRpcs(db);
  db.tables.account_deletions ??= [];
  const removed: string[] = [];
  const deps: CleanupDeps = {
    admin: db as unknown as SupabaseClient,
    workerSecret: SECRET,
    objects: { r2Bucket: 'vansen-test', r2: deadR2 },
    deleteAuthUser: (id: string) => {
      removed.push(id);
      return Promise.resolve();
    },
    ...over,
  };
  return { db, deps, removed };
}

async function queueOne(db: FakeDb, path: string): Promise<void> {
  const admin = db as unknown as SupabaseClient;
  const id = await registerObject(admin, {
    userId: USER,
    backend: 'supabase',
    bucket: 'media',
    path,
    purpose: 'media',
  });
  await db.storage.from('media').upload(path, new Uint8Array([1]), {
    contentType: 'image/png',
  });
  await enqueueDeletions(admin, [id], 'test');
}

function closure(db: FakeDb, over: Record<string, unknown> = {}): string {
  const id = crypto.randomUUID();
  db.tables.account_deletions.push({
    id,
    user_id: null,
    auth_user_id: USER,
    status: 'processing',
    data_finalized_at: db.now().toISOString(),
    ...over,
  });
  return id;
}

// ------------------------------------------------------------------- auth

Deno.test('the worker refuses anything but an authenticated POST', async () => {
  const { deps } = setup();
  const worker = createCleanupWorker(deps);

  assertEquals((await worker(new Request('http://x/', { method: 'GET' }))).status, 405);
  assertEquals((await worker(new Request('http://x/', { method: 'POST' }))).status, 401);
  assertEquals(
    (await worker(
      new Request('http://x/', { method: 'POST', headers: { 'x-worker-secret': 'wrong' } }),
    )).status,
    401,
  );
  assertEquals(
    (await worker(
      new Request('http://x/', { method: 'POST', headers: { 'x-worker-secret': SECRET } }),
    )).status,
    200,
  );
});

Deno.test('a worker with no secret configured deletes nothing', async () => {
  const { db, deps } = setup({ workerSecret: null });
  await queueOne(db, `${USER}/g1.png`);
  const worker = createCleanupWorker(deps);

  // Both shapes matter: a caller presenting a secret, and a caller presenting
  // none at all — an unset secret must not make "no header" the right answer.
  const withSecret = await worker(
    new Request('http://x/', { method: 'POST', headers: { 'x-worker-secret': SECRET } }),
  );
  const res = await worker(new Request('http://x/', { method: 'POST' }));

  assertEquals(withSecret.status, 401);
  assertEquals(res.status, 401);
  assertEquals(db.storage.objects.has(`media/${USER}/g1.png`), true);
  assertEquals(db.rpcCalls.some((r) => r.name === 'fn_claim_deletions'), false);
});

// ------------------------------------------------------------------- tick

Deno.test('a tick removes queued bytes and reports what it did', async () => {
  const { db, deps } = setup();
  await queueOne(db, `${USER}/g1.png`);
  await queueOne(db, `${USER}/g2.png`);

  const summary = await runCleanupTick(deps);

  assertEquals(summary.claimed, 2);
  assertEquals(summary.deleted, 2);
  assertEquals(db.storage.objects.size, 0);
});

Deno.test('a storage outage leaves the work queued instead of failing the tick', async () => {
  const { db, deps } = setup();
  await queueOne(db, `${USER}/g1.png`);
  db.failNext('rpc.fn_claim_deletions', 'connection terminated');

  const summary = await runCleanupTick(deps);

  assertEquals(summary.claimed, 0);
  assertEquals(db.tables.deletion_outbox[0].completed_at, null);
  assertEquals(db.storage.objects.has(`media/${USER}/g1.png`), true);
});

// --------------------------------------------------------------- closures

Deno.test('a finalised closure has its auth user removed and is completed', async () => {
  const { db, deps, removed } = setup();
  const id = closure(db);
  db.rpcHandlers.fn_complete_account_deletion = (args, self) => {
    const row = self.tables.account_deletions.find((r) => r.id === args.p_request);
    row!.status = 'completed';
    return { status: 'completed', requestId: args.p_request };
  };

  const summary = await runCleanupTick(deps);

  assertEquals(removed, [USER]);
  assertEquals(summary.closuresCompleted, 1);
  assertEquals(db.tables.account_deletions[0].status, 'completed');
  assertEquals(String(id).length, 36);
});

Deno.test('a closure whose data is not finalised is left alone', async () => {
  const { db, deps, removed } = setup();
  closure(db, { data_finalized_at: null });

  const summary = await runCleanupTick(deps);

  assertEquals(removed, [], 'the auth user is the LAST thing to go');
  assertEquals(summary.closuresCompleted, 0);
  assertEquals(summary.closuresPending, 0);
});

Deno.test('a closure the database will not complete stays open', async () => {
  const { db, deps, removed } = setup();
  closure(db);
  // A provider still holds a model trained on this customer's photos.
  db.rpcHandlers.fn_complete_account_deletion = () => ({
    status: 'processing',
    reason: 'provider_artifacts_unresolved',
  });

  const summary = await runCleanupTick(deps);

  assertEquals(removed, [USER]);
  assertEquals(summary.closuresCompleted, 0);
  assertEquals(summary.closuresPending, 1);
  assertEquals(db.tables.account_deletions[0].status, 'processing');
});

Deno.test('an auth deletion that fails does not complete the closure', async () => {
  const { db, deps } = setup({
    deleteAuthUser: () => Promise.reject(new Error('auth_delete_failed: 503')),
  });
  closure(db);
  let completed = false;
  db.rpcHandlers.fn_complete_account_deletion = () => {
    completed = true;
    return { status: 'completed' };
  };

  const summary = await runCleanupTick(deps);

  assertEquals(completed, false, 'a closure is not done while the sign-in still works');
  assertEquals(summary.closuresPending, 1);
});

Deno.test('one stuck closure does not stop the others', async () => {
  const { db, deps } = setup({
    deleteAuthUser: (id: string) =>
      id === 'bad' ? Promise.reject(new Error('503')) : Promise.resolve(),
  });
  closure(db, { auth_user_id: 'bad' });
  closure(db);
  db.rpcHandlers.fn_complete_account_deletion = () => ({ status: 'completed' });

  const summary = await runCleanupTick(deps);

  assertEquals(summary.closuresCompleted, 1);
  assertEquals(summary.closuresPending, 1);
});
