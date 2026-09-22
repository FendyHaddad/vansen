import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serveArgs, stop, stopChild, tickRequest, WORKER_INTERVAL_MS } from './stage.mjs';

test('functions are served with the staging env file and no jwt check', () => {
  assert.deepEqual(serveArgs(), [
    'functions', 'serve', '--no-verify-jwt', '--env-file', 'supabase/.env.staging',
  ]);
});

test('the worker tick carries the secret the worker demands', () => {
  const { url, init } = tickRequest({ JOB_WORKER_SECRET: 'shh' });
  assert.equal(url, 'http://127.0.0.1:54321/functions/v1/job-worker');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['x-worker-secret'], 'shh');
});

test('a missing worker secret is refused rather than sent as undefined', () => {
  assert.throws(() => tickRequest({}), /JOB_WORKER_SECRET/);
});

test('the tick interval is well under the 10 minute stale-job sweep', () => {
  assert.ok(WORKER_INTERVAL_MS > 0 && WORKER_INTERVAL_MS <= 30_000);
});

test('stopChild asks the whole group politely first and resolves once the child exits', async () => {
  const signals = [];
  const fake = {
    pid: 4242,
    exitCode: null,
    signalCode: null,
    handlers: {},
    once(event, fn) { this.handlers[event] = fn; },
  };
  const signal = (child, name) => {
    signals.push([child.pid, name]);
    fake.exitCode = 0;
    fake.handlers.exit();
  };
  await stopChild(fake, signal);
  assert.deepEqual(signals, [[4242, 'SIGINT']]);
});

test('stopChild does not wait on a child that is already gone', async () => {
  await stopChild({ exitCode: 1, signalCode: null });
  await stopChild({ exitCode: null, signalCode: 'SIGTERM' });
});

test('stop throws when supabase stop fails, rather than reporting success', () => {
  assert.throws(() => stop({ run: () => ({ status: 1 }), log: () => {} }), /supabase stop failed/);
});
