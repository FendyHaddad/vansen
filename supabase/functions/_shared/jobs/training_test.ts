import { assertEquals } from 'jsr:@std/assert';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { type ClaimedTrainingJob, runTrainingJob, type TrainingDeps } from './training.ts';
import type { TrainingCheck } from '../providers/fal.ts';

interface Calls {
  rpc: { name: string; args: Record<string, unknown> }[];
  submits: string[];
  checks: string[];
}

function harness(answers: Record<string, unknown> = {}) {
  const calls: Calls = { rpc: [], submits: [], checks: [] };
  const admin = {
    rpc(name: string, args: Record<string, unknown>) {
      calls.rpc.push({ name, args });
      const answer = name in answers ? answers[name] : true;
      return Promise.resolve({ data: answer, error: null });
    },
  } as unknown as SupabaseClient;
  return { calls, admin };
}

function deps(
  admin: SupabaseClient,
  calls: Calls,
  over: Partial<TrainingDeps> = {},
): TrainingDeps {
  return {
    admin,
    signZip: (path: string) => Promise.resolve(`https://fal.example/${path}?sig=fresh`),
    submit: (url: string) => {
      calls.submits.push(url);
      return Promise.resolve('ref_1');
    },
    check: (ref: string) => {
      calls.checks.push(ref);
      return Promise.resolve({ state: 'running' } as TrainingCheck);
    },
    ...over,
  };
}

function job(over: Partial<ClaimedTrainingJob> = {}): ClaimedTrainingJob {
  return {
    id: 'tj0',
    user_id: 'u1',
    persona_id: 'p1',
    state: 'ready',
    provider: 'fal',
    provider_ref: null,
    dispatch_key: 'dk0',
    lease_token: 't0',
    payload: { zipPath: 'persona-zips/u1/p1.zip' },
    submit_attempts: 0,
    poll_attempts: 0,
    cancel_requested_at: null,
    ...over,
  };
}

function rpcNamed(calls: Calls, name: string) {
  return calls.rpc.filter((r) => r.name === name);
}

Deno.test('a worker that lost the lease never reaches the provider', async () => {
  const { calls, admin } = harness({ fn_begin_training_submit: false });
  await runTrainingJob(deps(admin, calls), job());
  assertEquals(calls.submits.length, 0);
  assertEquals(rpcNamed(calls, 'fn_settle_training').length, 0);
});

Deno.test('a signed zip is minted at dispatch time, not reused from submission', async () => {
  const { calls, admin } = harness();
  await runTrainingJob(deps(admin, calls), job());
  assertEquals(calls.submits, ['https://fal.example/persona-zips/u1/p1.zip?sig=fresh']);
  const release = rpcNamed(calls, 'fn_release_training_job')[0];
  assertEquals(release.args.p_state, 'submitted');
  assertEquals(release.args.p_provider_ref, 'ref_1');
  assertEquals(rpcNamed(calls, 'fn_record_training_ref').length, 1);
});

Deno.test('a payload whose zip is gone fails before any provider call', async () => {
  const { calls, admin } = harness();
  await runTrainingJob(
    deps(admin, calls, { signZip: () => Promise.reject(new Error('object missing')) }),
    job(),
  );
  assertEquals(calls.submits.length, 0);
  const settle = rpcNamed(calls, 'fn_settle_training')[0];
  assertEquals(settle.args.p_outcome, 'failed');
  assertEquals(settle.args.p_error, 'payload_unavailable');
});

Deno.test('a provider that REJECTED the training refunds it', async () => {
  const { calls, admin } = harness();
  await runTrainingJob(
    deps(admin, calls, {
      submit: () => Promise.reject(new Error('fal 400: bad training zip')),
    }),
    job(),
  );
  assertEquals(rpcNamed(calls, 'fn_settle_training')[0].args.p_outcome, 'failed');
});

Deno.test('a submit that may have landed is held, not refunded', async () => {
  const { calls, admin } = harness();
  await runTrainingJob(
    deps(admin, calls, {
      submit: () => Promise.reject(new TypeError('error sending request for url')),
    }),
    job(),
  );
  assertEquals(rpcNamed(calls, 'fn_settle_training').length, 0);
  assertEquals(rpcNamed(calls, 'fn_release_training_job')[0].args.p_state, 'reconciling');
});

Deno.test('a running training is polled again, not settled', async () => {
  const { calls, admin } = harness();
  await runTrainingJob(deps(admin, calls), job({ state: 'submitted', provider_ref: 'ref_1' }));
  assertEquals(calls.checks, ['ref_1']);
  assertEquals(rpcNamed(calls, 'fn_settle_training').length, 0);
  assertEquals(rpcNamed(calls, 'fn_release_training_job')[0].args.p_state, 'submitted');
});

Deno.test('a finished training records the provider-hosted LoRA', async () => {
  const { calls, admin } = harness();
  await runTrainingJob(
    deps(admin, calls, {
      check: () => Promise.resolve({ state: 'done', loraUrl: 'https://fal.example/lora' }),
    }),
    job({ state: 'submitted', provider_ref: 'ref_1' }),
  );
  const settle = rpcNamed(calls, 'fn_settle_training')[0];
  assertEquals(settle.args.p_outcome, 'done');
  assertEquals(settle.args.p_lora_url, 'https://fal.example/lora');
  assertEquals(settle.args.p_token, 't0');
});

Deno.test('a poll that never reached the provider does NOT refund', async () => {
  const { calls, admin } = harness();
  await runTrainingJob(
    deps(admin, calls, {
      check: () => Promise.reject(new TypeError('error sending request for url')),
    }),
    job({ state: 'submitted', provider_ref: 'ref_1' }),
  );
  assertEquals(rpcNamed(calls, 'fn_settle_training').length, 0);
  assertEquals(rpcNamed(calls, 'fn_release_training_job')[0].args.p_state, 'submitted');
});

Deno.test('a cancel before dispatch refunds without asking the provider', async () => {
  const { calls, admin } = harness();
  await runTrainingJob(
    deps(admin, calls),
    job({ cancel_requested_at: '2026-09-21T00:00:00Z' }),
  );
  assertEquals(calls.submits.length, 0);
  const settle = rpcNamed(calls, 'fn_settle_training')[0];
  assertEquals(settle.args.p_outcome, 'failed');
  assertEquals(settle.args.p_error, 'cancelled');
});

Deno.test('a reconciling job with a reference polls it instead of training twice', async () => {
  const { calls, admin } = harness();
  await runTrainingJob(
    deps(admin, calls),
    job({ state: 'reconciling', provider_ref: 'ref_1' }),
  );
  assertEquals(calls.submits.length, 0);
  assertEquals(rpcNamed(calls, 'fn_release_training_job')[0].args.p_state, 'submitted');
});

Deno.test('a reconciling job with NO reference is held, never resubmitted', async () => {
  const { calls, admin } = harness();
  await runTrainingJob(deps(admin, calls), job({ state: 'reconciling', submit_attempts: 1 }));
  assertEquals(calls.submits.length, 0);
  assertEquals(rpcNamed(calls, 'fn_settle_training').length, 0);
  assertEquals(rpcNamed(calls, 'fn_release_training_job')[0].args.p_state, 'reconciling');
});
