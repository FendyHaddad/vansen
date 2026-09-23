import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyAll, CHECKS } from './verify-all.mjs';

const ok = () => ({ status: 0 });
const silent = () => {};
const TWO = [
  { name: 'first', cmd: 'a', args: [] },
  { name: 'second', cmd: 'b', args: [] },
];
const WITH_SQL = [...TWO, { name: 'sql', cmd: 'c', args: [], skipWithout: 'VANSEN_LOCAL_DB' }];

test('every check passing exits 0', () => {
  const { exitCode } = verifyAll({ checks: TWO, env: {}, run: ok, log: silent });
  assert.equal(exitCode, 0);
});

test('one failing check exits nonzero', () => {
  const run = (cmd) => ({ status: cmd === 'b' ? 1 : 0 });
  const { exitCode, results } = verifyAll({ checks: TWO, env: {}, run, log: silent });
  assert.equal(exitCode, 1);
  assert.equal(results.find((r) => r.name === 'second').status, 'FAIL');
});

test('a failure does not stop the remaining checks', () => {
  const seen = [];
  const run = (cmd) => { seen.push(cmd); return { status: cmd === 'a' ? 1 : 0 }; };
  verifyAll({ checks: TWO, env: {}, run, log: silent });
  assert.deepEqual(seen, ['a', 'b'], 'the second check must still run');
});

test('a spawn error is a failure, not a pass', () => {
  const run = () => ({ error: new Error('command not found') });
  const { exitCode } = verifyAll({ checks: TWO, env: {}, run, log: silent });
  assert.equal(exitCode, 1);
});

test('a signal-terminated check is a failure, not a pass', () => {
  // status is null on a signal death; `status === 0` is false, but an
  // implementation reading `status !== 0` as the only failure would pass it.
  const run = () => ({ status: null, signal: 'SIGKILL' });
  const { results, exitCode } = verifyAll({ checks: TWO, env: {}, run, log: silent });
  assert.equal(exitCode, 1);
  assert.ok(results.every((r) => r.status === 'FAIL'));
});

test('a skipped SQL check blocks the gate', () => {
  const { exitCode, results } = verifyAll({ checks: WITH_SQL, env: {}, run: ok, log: silent });
  assert.equal(results.find((r) => r.name === 'sql').status, 'SKIPPED');
  assert.equal(exitCode, 1, 'a skipped check is not a passed check');
});

test('the SQL check runs when its environment is present', () => {
  const seen = [];
  const run = (cmd) => { seen.push(cmd); return { status: 0 }; };
  const { exitCode } = verifyAll({
    checks: WITH_SQL, env: { VANSEN_LOCAL_DB: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' },
    run, log: silent,
  });
  assert.deepEqual(seen, ['a', 'b', 'c']);
  assert.equal(exitCode, 0);
});

test('the skip notice names the missing variable, not its value', () => {
  const lines = [];
  verifyAll({ checks: WITH_SQL, env: {}, run: ok, log: (...a) => lines.push(a.join(' ')) });
  const joined = lines.join('\n');
  assert.ok(joined.includes('VANSEN_LOCAL_DB not set'));
  assert.ok(joined.includes('a skipped check is not a passed check'));
});

test('the real check list covers each suite the release depends on', () => {
  const names = CHECKS.map((c) => c.name);
  for (const required of [
    'web unit tests', 'web production build', 'deno tests', 'deno type check',
    'shared catalog drift', 'catalog assets', 'migration inventory', 'sql integration',
  ]) {
    assert.ok(names.includes(required), `verify-all lost the "${required}" check`);
  }
});

test('only the SQL check is skippable', () => {
  const skippable = CHECKS.filter((c) => c.skipWithout).map((c) => c.name);
  assert.deepEqual(skippable, ['sql integration']);
});
