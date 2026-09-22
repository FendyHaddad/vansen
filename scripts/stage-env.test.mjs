import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FAMILY_KEY, familyPlan, loadStagingEnv, parseEnvFile } from './stage-env.mjs';

test('parseEnvFile ignores comments, blanks and empty values', () => {
  const parsed = parseEnvFile([
    '# a comment',
    '',
    'FAL_API_KEY=abc123',
    'OPENAI_API_KEY=',
    '  GOOGLE_AI_API_KEY = "spaced"  ',
    'NOT_A_PAIR',
  ].join('\n'));
  assert.deepEqual(parsed, { FAL_API_KEY: 'abc123', GOOGLE_AI_API_KEY: 'spaced' });
});

test('a value containing = keeps everything after the first one', () => {
  assert.equal(parseEnvFile('K=a=b=c').K, 'a=b=c');
});

test('familyPlan enables only the families whose key is present', () => {
  const plan = familyPlan({ FAL_API_KEY: 'k' });
  assert.deepEqual(plan.enabled.sort(), [
    'edit-bg', 'edit-expand', 'edit-fill', 'edit-remove', 'flux', 'persona',
    'seedream', 'upscaler',
  ]);
  assert.deepEqual(plan.disabled.sort(), ['gpt-image', 'nano-banana']);
  assert.equal(plan.moderation, false);
});

test('familyPlan reports moderation separately from any family', () => {
  assert.equal(familyPlan({ OPENAI_API_KEY: 'k' }).moderation, true);
});

test('familyPlan with no keys disables everything', () => {
  const plan = familyPlan({});
  assert.equal(plan.enabled.length, 0);
  assert.equal(plan.disabled.length, Object.keys(FAMILY_KEY).length);
});

test('loadStagingEnv names the example file when the real one is missing', () => {
  assert.throws(
    () => loadStagingEnv({ exists: () => false }),
    /supabase\/\.env\.staging\.example/,
  );
});

// Drift guard. If a family is added to the provider index without a staging
// key mapping, the seed would silently leave it enabled with no key behind it.
test('every image family in the provider index has a staging key', () => {
  const source = readFileSync('supabase/functions/_shared/providers/index.ts', 'utf8');
  const table = source.slice(
    source.indexOf('const BY_FAMILY'),
    source.indexOf('export function adapterFor'),
  );
  const families = [...table.matchAll(/^\s*'?([a-z][a-z-]*)'?:\s*\w+Adapter,/gm)].map((m) => m[1]);
  assert.ok(families.length > 5, 'the BY_FAMILY table did not parse');

  const VIDEO = new Set(['veo', 'omni', 'kling', 'runway', 'seedance']);
  const image = families.filter((f) => !VIDEO.has(f)).sort();
  assert.deepEqual(image, Object.keys(FAMILY_KEY).sort());
});
