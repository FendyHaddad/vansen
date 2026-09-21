import { assertEquals, assertRejects } from 'jsr:@std/assert';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import {
  enqueueDeletions,
  holdObject,
  markObjectLive,
  putTracked,
  registerObject,
} from './registry.ts';

interface Call {
  name: string;
  args: Record<string, unknown>;
}

function db(answers: Record<string, unknown> = {}, fail?: string) {
  const calls: Call[] = [];
  const admin = {
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      if (name === fail) {
        return Promise.resolve({ data: null, error: { message: 'boom' } });
      }
      return Promise.resolve({ data: name in answers ? answers[name] : true, error: null });
    },
  } as unknown as SupabaseClient;
  return { admin, calls };
}

const REF = {
  userId: 'u1',
  backend: 'supabase' as const,
  bucket: 'uploads',
  path: 'u1/a.png',
  purpose: 'upload' as const,
};

Deno.test('registerObject passes the exact locator, bucket included', async () => {
  const { admin, calls } = db({ fn_register_object: 'obj-1' });
  const id = await registerObject(admin, REF);
  assertEquals(id, 'obj-1');
  assertEquals(calls[0].args, {
    p_user: 'u1',
    p_backend: 'supabase',
    p_bucket: 'uploads',
    p_path: 'u1/a.png',
    p_purpose: 'upload',
  });
});

Deno.test('a registry failure is fatal — bytes are never written untracked', async () => {
  const { admin } = db({}, 'fn_register_object');
  await assertRejects(() => registerObject(admin, REF), Error, 'register_object_failed');
});

Deno.test('a registry that answers nothing is also a failure', async () => {
  const { admin } = db({ fn_register_object: null });
  await assertRejects(() => registerObject(admin, REF), Error, 'register_object_failed');
});

Deno.test('putTracked records intent BEFORE the write and marks live after', async () => {
  const { admin, calls } = db({ fn_register_object: 'obj-1' });
  const order: string[] = [];
  await putTracked(admin, REF, () => {
    order.push('put');
    return Promise.resolve();
  });
  assertEquals(calls.map((c) => c.name), ['fn_register_object', 'fn_mark_object_live']);
  assertEquals(order, ['put']);
});

Deno.test('a failed write leaves the locator staged, not lost', async () => {
  const { admin, calls } = db({ fn_register_object: 'obj-1' });
  await assertRejects(
    () => putTracked(admin, REF, () => Promise.reject(new Error('storage down'))),
    Error,
    'storage down',
  );
  // Registered, never promoted: the inventory can still find these bytes.
  assertEquals(calls.map((c) => c.name), ['fn_register_object']);
});

Deno.test('a failed mark-live does not fail the write that already landed', async () => {
  const { admin } = db({ fn_register_object: 'obj-1' }, 'fn_mark_object_live');
  const live = await markObjectLive(admin, 'obj-1');
  assertEquals(live, false);
});

Deno.test('enqueueDeletions sends registry ids and skips an empty list', async () => {
  const { admin, calls } = db({ fn_enqueue_deletions: 2 });
  assertEquals(await enqueueDeletions(admin, [], 'nothing'), 0);
  assertEquals(calls.length, 0);
  assertEquals(await enqueueDeletions(admin, ['a', 'b'], 'generation_deleted'), 2);
  assertEquals(calls[0].args.p_objects, ['a', 'b']);
  assertEquals(calls[0].args.p_reason, 'generation_deleted');
});

Deno.test('an enqueue failure is loud: the caller must not report a deletion', async () => {
  const { admin } = db({}, 'fn_enqueue_deletions');
  await assertRejects(
    () => enqueueDeletions(admin, ['a'], 'generation_deleted'),
    Error,
    'enqueue_deletions_failed',
  );
});

Deno.test('holdObject passes an ISO deadline', async () => {
  const { admin, calls } = db();
  const until = new Date('2027-09-21T00:00:00Z');
  assertEquals(await holdObject(admin, 'obj-1', until), true);
  assertEquals(calls[0].args.p_until, '2027-09-21T00:00:00.000Z');
});
