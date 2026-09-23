// Proves the shared-sync drift check actually fails on drift — and that it
// never writes. A "check" that silently regenerates what it is checking would
// pass forever while the Angular and Deno copies of the catalog diverged.
//
//   node --test scripts/catalog-check.test.mjs
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { FILES, runSync, transformed } from './sync-shared.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A throwaway copy of just the files the shared sync touches. */
function fixtureTree() {
  const dir = mkdtempSync(join(tmpdir(), 'vansen-sync-'));
  for (const file of FILES) {
    const dest = join(dir, file.src);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(root, file.src), dest);
  }
  return dir;
}

function sharedPath(dir, file) {
  return join(dir, 'supabase', 'functions', '_shared', file.out);
}

function snapshot(paths) {
  return paths.map((p) => {
    const s = statSync(p);
    return { p, size: s.size, mtimeMs: s.mtimeMs, bytes: readFileSync(p, 'utf8') };
  });
}

function assertUntouched(before) {
  for (const entry of before) {
    const now = statSync(entry.p);
    assert.equal(now.size, entry.size, `${entry.p} changed size`);
    assert.equal(now.mtimeMs, entry.mtimeMs, `${entry.p} was rewritten`);
    assert.equal(readFileSync(entry.p, 'utf8'), entry.bytes, `${entry.p} contents changed`);
  }
}

test('shared --check fails when an output is missing', () => {
  const dir = fixtureTree();
  try {
    assert.throws(() => runSync(dir, ['node', 'sync-shared.mjs', '--check']), /shared drift/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shared --check passes on a freshly generated tree, and writes nothing', () => {
  const dir = fixtureTree();
  try {
    runSync(dir, ['node', 'sync-shared.mjs']);
    const outputs = FILES.map((f) => sharedPath(dir, f));
    const before = snapshot(outputs);
    runSync(dir, ['node', 'sync-shared.mjs', '--check']);
    assertUntouched(before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shared --check fails when the Deno copy is edited', () => {
  const dir = fixtureTree();
  try {
    runSync(dir, ['node', 'sync-shared.mjs']);
    const target = sharedPath(dir, FILES[0]);
    writeFileSync(target, `${readFileSync(target, 'utf8')}\n// tampered\n`);
    assert.throws(() => runSync(dir, ['node', 'sync-shared.mjs', '--check']), /shared drift/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shared --check fails when the master changes and the copy does not', () => {
  const dir = fixtureTree();
  try {
    runSync(dir, ['node', 'sync-shared.mjs']);
    const master = join(dir, FILES[0].src);
    writeFileSync(master, `${readFileSync(master, 'utf8')}\nexport const ADDED = 1;\n`);
    assert.notEqual(transformed(FILES[0], dir), readFileSync(sharedPath(dir, FILES[0]), 'utf8'));
    assert.throws(() => runSync(dir, ['node', 'sync-shared.mjs', '--check']), /shared drift/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shared --check fails when a new catalog file is neither synced nor marked web-only', () => {
  const dir = fixtureTree();
  try {
    // A split like the WS4 model-families revamp adds a new file under
    // core/catalog/ and forgets to add it to CATALOG_MODULES — this must not
    // pass silently, or the server catalog just quietly falls behind.
    const strayPath = join(dir, 'src/app/core/catalog/stray-new-module.ts');
    writeFileSync(strayPath, 'export const STRAY = 1;\n');
    assert.throws(
      () => runSync(dir, ['node', 'sync-shared.mjs', '--check']),
      /not synced and not marked web-only/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shared --check passes a stray catalog spec file (specs are never synced)', () => {
  const dir = fixtureTree();
  try {
    runSync(dir, ['node', 'sync-shared.mjs']);
    const strayPath = join(dir, 'src/app/core/catalog/stray-new-module.spec.ts');
    writeFileSync(strayPath, "import { describe } from 'vitest';\ndescribe('x', () => {});\n");
    // Should not throw on account of the stray spec file.
    runSync(dir, ['node', 'sync-shared.mjs', '--check']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shared --check fails when a master uses a relative-import style withTsExtensions cannot rewrite', () => {
  const dir = fixtureTree();
  try {
    runSync(dir, ['node', 'sync-shared.mjs']);
    const creditCost = FILES.find((f) => f.src.endsWith('credit-cost.ts'));
    const master = join(dir, creditCost.src);
    // Double quotes: withTsExtensions' regex only matches single-quoted
    // `from '...';` specifiers, so this relative import is left un-rewritten
    // and would 404 as a Deno import at deploy time.
    const original = readFileSync(master, 'utf8');
    const tampered = original.replace(
      "from './generation-input';",
      'from "./generation-input";',
    );
    assert.notEqual(tampered, original, 'fixture text did not match');
    writeFileSync(master, tampered);
    assert.throws(() => runSync(dir, ['node', 'sync-shared.mjs', '--check']), /did not rewrite/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

