#!/usr/bin/env node
/**
 * Every automated release check, fastest-failing first.
 *
 * Before this, "did we run the tests?" was answered from memory, and the
 * answer was usually "the ones I remembered". Each check below corresponds to
 * a defect class an earlier plan closed; a green run is the evidence they are
 * all still closed.
 *
 * What a green run is NOT: release readiness. Authenticated browser checks,
 * real devices, paid provider smokes, policy review and backup restore are
 * recorded separately in docs/superpowers/plans/2026-09-20-release-evidence.md.
 * No amount of passing CI closes those.
 */
import { spawnSync } from 'node:child_process';

export const CHECKS = [
  { name: 'migration inventory', cmd: 'node', args: ['scripts/migration-inventory.mjs'] },
  { name: 'script unit tests', cmd: 'npm', args: ['run', 'test:scripts'] },
  { name: 'shared catalog drift', cmd: 'node', args: ['scripts/sync-shared.mjs', '--check'] },
  { name: 'trend assets', cmd: 'npm', args: ['run', 'check:assets'] },
  { name: 'deno type check', cmd: 'deno', args: ['check', 'api/index.ts', 'api/app.ts', 'job-worker/index.ts', 'cleanup-worker/index.ts', 'stripe-webhook/index.ts', 'appstore-webhook/index.ts'], cwd: 'supabase/functions' },
  { name: 'deno tests', cmd: 'deno', args: ['test', '--allow-all', '_shared', 'api', 'job-worker', 'cleanup-worker', 'stripe-webhook', 'appstore-webhook'], cwd: 'supabase/functions' },
  { name: 'web unit tests', cmd: 'npm', args: ['test', '--', '--watch=false'] },
  { name: 'web production build', cmd: 'npx', args: ['ng', 'build', '--configuration', 'production'] },
  { name: 'sql integration', cmd: 'node', args: ['scripts/run-sql-tests.mjs'], skipWithout: 'VANSEN_LOCAL_DB' },
];

/**
 * One check's outcome. A spawn error and a signal both mean "we do not know
 * that this passed", which is a failure -- reading only `status !== 0` would
 * score a killed process as a pass.
 */
function statusOf(result) {
  if (result.error) return 'FAIL';
  if (result.signal) return 'FAIL';
  return result.status === 0 ? 'PASS' : 'FAIL';
}

export function verifyAll({
  checks = CHECKS,
  env = process.env,
  run = spawnSync,
  log = console.log,
  now = Date.now,
} = {}) {
  const results = [];

  for (const check of checks) {
    if (check.skipWithout && !env[check.skipWithout]) {
      results.push({ name: check.name, status: 'SKIPPED', note: `${check.skipWithout} not set` });
      continue;
    }
    const started = now();
    const out = run(check.cmd, check.args, { cwd: check.cwd, stdio: 'inherit', shell: false, env });
    results.push({
      name: check.name,
      status: statusOf(out),
      seconds: Math.round((now() - started) / 1000),
    });
    // Keep going. One failure should not hide the other nine.
  }

  log('\n─── verify-all ───');
  for (const r of results) log(`${r.status.padEnd(8)} ${r.name} ${r.note ?? `${r.seconds}s`}`);

  const failed = results.filter((r) => r.status === 'FAIL');
  const skipped = results.filter((r) => r.status === 'SKIPPED');
  if (skipped.length) {
    log(`\n${skipped.length} check(s) skipped — a skipped check is not a passed check.`);
  }
  return { results, exitCode: failed.length || skipped.length ? 1 : 0 };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(verifyAll().exitCode);
}
