import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { inventory, versionOf } from './migration-inventory.mjs';

const silent = () => {};

test('the version is everything before the first underscore', () => {
  assert.equal(versionOf('0020_durable_dispatch.sql'), '0020');
  assert.equal(versionOf('00091_age_gate.sql'), '00091');
  assert.equal(versionOf('20260922120000_thing.sql'), '20260922120000');
});

test('a five-digit version is not a collision with a four-digit one', () => {
  // This is the exact pair in the repository. Calling them a duplicate would
  // invite renaming a migration that has already been applied everywhere.
  const { unexpected } = inventory({
    readDir: () => ['00091_age_gate.sql', '0009_pending_plan_change.sql'],
    log: silent,
  });
  assert.deepEqual(unexpected, []);
});

test('two files sharing one version are a NEW collision and fail', () => {
  const { unexpected } = inventory({
    readDir: () => ['0030_a.sql', '0030_b.sql'],
    log: silent,
  });
  assert.equal(unexpected.length, 1);
  assert.equal(unexpected[0][0], '0030');
});

test('a NEW collision is reported by name so it can be decided', () => {
  const lines = [];
  inventory({ readDir: () => ['0030_a.sql', '0030_b.sql'], log: (...a) => lines.push(a.join(' ')) });
  assert.ok(lines.join('\n').includes('NEW duplicate prefix 0030: 0030_a.sql, 0030_b.sql'));
});

test('non-SQL files are ignored', () => {
  const { files } = inventory({
    readDir: () => ['0001_a.sql', 'README.md', '.DS_Store'],
    log: silent,
  });
  assert.deepEqual(files, ['0001_a.sql']);
});

test('the real migrations directory has no unresolved collision', () => {
  const { unexpected, files } = inventory({ readDir: readdirSync, log: silent });
  assert.deepEqual(unexpected, [], 'a new duplicate version arrived and must be decided, not renamed');
  assert.ok(files.length > 20, 'the migration set should not have shrunk');
});

test('0024 belongs to the applied worker guard, not to release telemetry', () => {
  // P9 originally reserved 0024 for telemetry. 0024_worker_drive_guard.sql was
  // applied to the live database first, so telemetry is 0025. Renumbering an
  // applied migration would corrupt the ledger of what ran.
  const { files } = inventory({ readDir: readdirSync, log: silent });
  const owner = files.find((f) => versionOf(f) === '0024');
  assert.equal(owner, '0024_worker_drive_guard.sql');
});
