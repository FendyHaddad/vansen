import { assertEquals, assertRejects } from 'jsr:@std/assert';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { FakeDb } from '../testing/fakes.ts';
import { backoffSeconds, claimJobs, releaseJob, renewLease } from './lease.ts';

function db(): FakeDb {
  const fake = new FakeDb();
  fake.tables.generations = [
    { id: 'g0', family_id: 'flux', kind: 'image' },
    { id: 'g1', family_id: 'kling', kind: 'video' },
  ];
  fake.rpcHandlers.fn_claim_jobs = () => [
    { id: 'j0', user_id: 'u0', generation_id: 'g0', state: 'ready', lease_token: 'lease-0' },
    { id: 'j1', user_id: 'u0', generation_id: 'g1', state: 'submitted', lease_token: 'lease-1' },
  ];
  return fake;
}

Deno.test('a claim carries the family and kind the adapter needs', async () => {
  const fake = db();
  const jobs = await claimJobs(fake as unknown as SupabaseClient, 10);
  assertEquals(jobs.map((j) => j.family_id), ['flux', 'kling']);
  assertEquals(jobs.map((j) => j.kind), ['image', 'video']);
});

Deno.test('a job whose generation cannot be read is not runnable', async () => {
  const fake = db();
  fake.tables.generations = [{ id: 'g0', family_id: 'flux', kind: 'image' }];
  const jobs = await claimJobs(fake as unknown as SupabaseClient, 10);
  // Submitting it would mean guessing which provider it belongs to.
  assertEquals(jobs.map((j) => j.id), ['j0']);
});

Deno.test('a failed claim is raised, never read as "no work"', async () => {
  const fake = db();
  fake.rpcHandlers.fn_claim_jobs = () => {
    throw new Error('deadlock detected');
  };
  await assertRejects(
    () => claimJobs(fake as unknown as SupabaseClient, 10),
    Error,
    'deadlock detected',
  );
});

Deno.test('a failed generation lookup is raised too', async () => {
  const fake = db();
  fake.failNext('generations.select', 'connection reset');
  await assertRejects(
    () => claimJobs(fake as unknown as SupabaseClient, 10),
    Error,
    'connection reset',
  );
});

Deno.test('release and renew report whether they actually changed a row', async () => {
  const fake = db();
  fake.rpcHandlers.fn_release_job = (args) => args.p_token === 'live';
  fake.rpcHandlers.fn_renew_job_lease = (args) => args.p_token === 'live';
  const admin = fake as unknown as SupabaseClient;
  assertEquals(await releaseJob(admin, 'j0', 'live', { state: 'submitted' }), true);
  assertEquals(await releaseJob(admin, 'j0', 'stale', { state: 'submitted' }), false);
  assertEquals(await renewLease(admin, 'j0', 'live'), true);
  assertEquals(await renewLease(admin, 'j0', 'stale'), false);
});

Deno.test('an RPC whose outcome is unknown is not reported as success', async () => {
  const fake = db();
  fake.rpcHandlers.fn_release_job = () => {
    throw new Error('connection reset');
  };
  await assertRejects(
    () => releaseJob(fake as unknown as SupabaseClient, 'j0', 'live', { state: 'done' }),
    Error,
    'connection reset',
  );
});

Deno.test('a negative delay is never sent to the database', async () => {
  const fake = db();
  let sent: unknown = null;
  fake.rpcHandlers.fn_release_job = (args) => {
    sent = args.p_delay_seconds;
    return true;
  };
  await releaseJob(fake as unknown as SupabaseClient, 'j0', 'live', {
    state: 'submitted',
    delaySeconds: -30,
  });
  assertEquals(sent, 0);
});

Deno.test('backoff grows, stays inside 1..300, and respects Retry-After', () => {
  for (const attempt of [0, 1, 5, 20, 100]) {
    const wait = backoffSeconds(attempt);
    assertEquals(wait >= 1 && wait <= 300, true, `attempt ${attempt} gave ${wait}`);
  }
  assertEquals(backoffSeconds(0) <= backoffSeconds(6), true, 'later attempts wait longer');
  assertEquals(backoffSeconds(0, 42), 42);
  // A header is an input: an absurd one is clamped, not obeyed.
  assertEquals(backoffSeconds(0, 99_999), 300);
  assertEquals(backoffSeconds(0, -5) >= 1, true);
});
