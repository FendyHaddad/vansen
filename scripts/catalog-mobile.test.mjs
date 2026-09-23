// Proves `npm run catalog:mobile <path>` writes the catalog mobile bundles:
// the /catalog payload with the models table as the migrations seed it.
//
//   node --test scripts/catalog-mobile.test.mjs
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function run(args) {
  return spawnSync('npx', ['tsx', 'scripts/catalog-mobile.mjs', ...args], { cwd: root, encoding: 'utf8' });
}

test('catalog:mobile writes the seed-state catalog to the given path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vansen-catalog-'));
  try {
    const out = join(dir, 'nested', 'catalog.json');
    const result = run([out]);
    assert.equal(result.status, 0, result.stderr);
    const catalog = JSON.parse(readFileSync(out, 'utf8'));
    const byId = Object.fromEntries(catalog.families.map((f) => [f.id, f]));
    assert.match(catalog.catalogVersion, /^\d{4}-\d{2}-\d{2}\.\d+$/);
    assert.equal(byId['nano-banana'].enabled, true);
    assert.equal(byId['gpt-image'].enabled, true);
    assert.equal(byId.flux.maxReferences, 0);
    assert.equal(byId.veo.enabled, false);
    assert.equal(byId.veo.plan, 'pro');
    assert.equal(catalog.flat.upscale.enabled, true);
    assert.equal(catalog.flat.persona.enabled, false);
    assert.equal(catalog.flat.editTools.every((t) => t.enabled && t.plan === 'studio'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('catalog:mobile refuses to run without an output path', () => {
  const result = run([]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /usage: npm run catalog:mobile <outPath>/);
});
