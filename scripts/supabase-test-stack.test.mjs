import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  cliDrift,
  hashOf,
  main,
  manifestDrift,
  startStack,
  stopStack,
} from './supabase-test-stack.mjs';

const MANIFEST = {
  cliVersion: '2.114.0',
  migrations: [
    { file: '0001_a.sql', sha256: hashOf('a') },
    { file: '0002_b.sql', sha256: hashOf('b') },
  ],
};

function io(over = {}) {
  const calls = [];
  const errors = [];
  return {
    calls,
    errors,
    readFile: (p) => (p.endsWith('bootstrap-manifest.json')
      ? JSON.stringify(MANIFEST)
      : ({ 'supabase/migrations/0001_a.sql': 'a', 'supabase/migrations/0002_b.sql': 'b' }[p] ?? p)),
    readDir: () => ['0001_a.sql', '0002_b.sql'],
    log: () => {},
    error: (m) => errors.push(String(m)),
    run: (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
      if (args[0] === '--version') return { stdout: '2.114.0\n', status: 0 };
      return { status: 0 };
    },
    ...over,
  };
}

test('a clean repository starts the stack', () => {
  const deps = io();
  assert.equal(startStack(deps), 0);
  assert.ok(deps.calls.includes('supabase start'));
});

test('an edited migration stops the run before the stack comes up', () => {
  // The whole point: a migration changed without the inventory being updated
  // means CI would be proving something about a database nobody described.
  const deps = io({ readFile: (p) => (p.endsWith('.json') ? JSON.stringify(MANIFEST) : 'EDITED') });
  assert.equal(startStack(deps), 1);
  assert.ok(!deps.calls.includes('supabase start'), 'must not start on drift');
  assert.match(deps.errors.join('\n'), /0001_a\.sql changed/);
});

test('a new migration is reported, not silently accepted', () => {
  const deps = io({ readDir: () => ['0001_a.sql', '0002_b.sql', '0003_new.sql'] });
  assert.equal(startStack(deps), 1);
  assert.match(deps.errors.join('\n'), /0003_new\.sql is not in the manifest/);
});

test('a deleted migration is reported too', () => {
  const deps = io({ readDir: () => ['0001_a.sql'] });
  assert.equal(startStack(deps), 1);
  assert.match(deps.errors.join('\n'), /0002_b\.sql is in the manifest but missing/);
});

test('every drift is listed in one run, not one per run', () => {
  const problems = manifestDrift(MANIFEST.migrations, [
    { file: '0001_a.sql', sha256: 'changed' },
    { file: '0003_new.sql', sha256: 'x' },
  ]);
  assert.equal(problems.length, 3, problems.join(' | '));
});

test('a different CLI is refused with the version it found', () => {
  // Newer CLI, newer auth/storage/postgres images: a different baseline.
  const message = cliDrift('2.114.0', '2.200.0');
  assert.match(message, /2\.200\.0/);
  assert.match(message, /2\.114\.0/);
});

test('a missing CLI is refused rather than assumed fine', () => {
  assert.match(cliDrift('2.114.0', ''), /not installed/);
});

test('the pinned CLI passes', () => {
  assert.equal(cliDrift('2.114.0', '2.114.0'), null);
});

test('missing Docker fails loudly instead of leaving the gates half-run', () => {
  const deps = io({
    run: (cmd, args) => {
      if (args[0] === '--version') return { stdout: '2.114.0\n', status: 0 };
      return { error: new Error('Cannot connect to the Docker daemon') };
    },
  });
  assert.equal(startStack(deps), 1);
  assert.match(deps.errors.join('\n'), /Docker/);
});

test('a failed start is a failure, not a warning', () => {
  const deps = io({
    run: (cmd, args) => (args[0] === '--version'
      ? { stdout: '2.114.0\n', status: 0 }
      : { status: 1 }),
  });
  assert.equal(startStack(deps), 1);
  assert.match(deps.errors.join('\n'), /skipped gate is not a passed gate/);
});

test('stop never keeps a backup of the throwaway database', () => {
  const deps = io();
  assert.equal(stopStack(deps), 0);
  assert.ok(deps.calls.includes('supabase stop --no-backup'));
});

test('an unknown command fails rather than doing something surprising', () => {
  const deps = io();
  assert.equal(main(['node', 'x', 'restart'], deps), 1);
  assert.match(deps.errors.join('\n'), /unknown command/);
});
