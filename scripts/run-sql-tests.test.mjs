import test from 'node:test';
import assert from 'node:assert/strict';
import { runSqlTests } from './run-sql-tests.mjs';

const LOCAL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const FILES = ['alerts.sql', 'caps_concurrency.sh', 'deletion.sql'];

/** A runner that succeeds at everything and records what it was asked to do. */
function recorder(outcome = () => ({ status: 0 })) {
  const calls = [];
  const run = (command, args) => {
    calls.push({ command, args });
    return outcome(command, args, calls.length);
  };
  return { calls, run };
}

const silent = () => {};

test('a missing environment fails rather than skipping', () => {
  assert.throws(
    () => runSqlTests({ env: {}, readDir: () => FILES, run: () => ({ status: 0 }), log: silent }),
    /cannot be skipped/,
  );
});

test('a remote database is refused', () => {
  assert.throws(
    () => runSqlTests({
      env: { VANSEN_LOCAL_DB: 'postgresql://u:p@db.bnorhcxhvxydkgvcxjad.supabase.co:5432/postgres' },
      readDir: () => FILES,
      run: () => ({ status: 0 }),
      log: silent,
    }),
    /disposable local database/,
  );
});

test('the refusal never quotes the connection string', () => {
  const secret = 'postgresql://postgres:hunter2@db.example.com:5432/postgres';
  try {
    runSqlTests({ env: { VANSEN_LOCAL_DB: secret }, readDir: () => FILES, run: () => ({ status: 0 }), log: silent });
    assert.fail('expected a refusal');
  } catch (error) {
    assert.ok(!error.message.includes('hunter2'), `leaked the password: ${error.message}`);
    assert.ok(!error.message.includes(secret));
  }
});

test('an empty test directory fails: nothing ran, so nothing passed', () => {
  assert.throws(
    () => runSqlTests({ env: { VANSEN_LOCAL_DB: LOCAL }, readDir: () => [], run: () => ({ status: 0 }), log: silent }),
    /no SQL tests discovered/,
  );
});

test('a directory of only shell harnesses fails: the SQL suite is the point', () => {
  assert.throws(
    () => runSqlTests({
      env: { VANSEN_LOCAL_DB: LOCAL }, readDir: () => ['caps_concurrency.sh'],
      run: () => ({ status: 0 }), log: silent,
    }),
    /no SQL tests discovered/,
  );
});

test('the preflight runs before any test file', () => {
  const { calls, run } = recorder();
  runSqlTests({ env: { VANSEN_LOCAL_DB: LOCAL }, readDir: () => FILES, run, log: silent });
  assert.equal(calls[0].command, 'psql');
  assert.ok(calls[0].args.includes('-c'), 'the first call must be the inline preflight');
  assert.ok(calls[0].args.join(' ').includes('pg_net'));
});

test('a failed preflight stops before running anything', () => {
  const { calls, run } = recorder((_c, _a, n) => (n === 1 ? { status: 1 } : { status: 0 }));
  assert.throws(
    () => runSqlTests({ env: { VANSEN_LOCAL_DB: LOCAL }, readDir: () => FILES, run, log: silent }),
    /SQL gate failed/,
  );
  assert.equal(calls.length, 1, 'a missing schema must not run the suite anyway');
});

test('every discovered file runs exactly once, .sql via psql and .sh via bash', () => {
  const { calls, run } = recorder();
  runSqlTests({ env: { VANSEN_LOCAL_DB: LOCAL }, readDir: () => FILES, run, log: silent });
  const afterPreflight = calls.slice(1);
  assert.equal(afterPreflight.length, FILES.length);
  assert.deepEqual(
    afterPreflight.map((c) => c.command),
    ['psql', 'bash', 'psql'],
  );
  const targets = afterPreflight.map((c) => c.args[c.args.length - 1]);
  assert.deepEqual(targets, FILES.map((f) => `supabase/tests/${f}`));
});

test("P8's request_snapshots.sql is picked up without being named", () => {
  const { calls, run } = recorder();
  runSqlTests({
    env: { VANSEN_LOCAL_DB: LOCAL },
    readDir: () => ['request_snapshots.sql'],
    run,
    log: silent,
  });
  assert.ok(calls.some((c) => c.args.join(' ').includes('request_snapshots.sql')));
});

test('a failing SQL file fails the gate', () => {
  const { run } = recorder((command, args) =>
    args.join(' ').includes('deletion.sql') ? { status: 1 } : { status: 0 });
  assert.throws(
    () => runSqlTests({ env: { VANSEN_LOCAL_DB: LOCAL }, readDir: () => FILES, run, log: silent }),
    /SQL gate failed: psql/,
  );
});

test('a failing shell harness fails the gate', () => {
  const { run } = recorder((command) => (command === 'bash' ? { status: 1 } : { status: 0 }));
  assert.throws(
    () => runSqlTests({ env: { VANSEN_LOCAL_DB: LOCAL }, readDir: () => FILES, run, log: silent }),
    /SQL gate failed: bash/,
  );
});

test('a spawn error is a failure, not a pass', () => {
  const { run } = recorder(() => ({ error: new Error('psql: not found') }));
  assert.throws(
    () => runSqlTests({ env: { VANSEN_LOCAL_DB: LOCAL }, readDir: () => FILES, run, log: silent }),
    /could not start psql/,
  );
});

test('a signal-terminated child is a failure, not a pass', () => {
  // status is null when a process dies on a signal. Checking only `status !== 0`
  // would read that as success.
  const { run } = recorder(() => ({ status: null, signal: 'SIGKILL' }));
  assert.throws(
    () => runSqlTests({ env: { VANSEN_LOCAL_DB: LOCAL }, readDir: () => FILES, run, log: silent }),
    /SIGKILL/,
  );
});

test('every file passing returns the list that ran', () => {
  const { run } = recorder();
  const ran = runSqlTests({ env: { VANSEN_LOCAL_DB: LOCAL }, readDir: () => FILES, run, log: silent });
  assert.deepEqual(ran, FILES);
});
