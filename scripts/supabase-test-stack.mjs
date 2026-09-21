#!/usr/bin/env node
/**
 * Start and stop the local Supabase stack that the SQL gates run against.
 *
 * The suite in supabase/tests/ reads auth.users, storage.objects, cron.job and
 * pg_net. A bare Postgres container has none of those, so it would report a
 * confident PASS on tests that never exercised the thing they are named after.
 * This starts the real stack, at the pinned CLI version, or refuses.
 *
 * **Deviation from P9 Task 5, recorded deliberately.** The plan specifies a
 * copied disposable project directory with a test-only version mapping. That
 * design existed to work around two migrations sharing the `0008_` prefix. As
 * of 2026-09-22 they no longer do -- `0008_age_gate.sql` was renamed
 * `00091_age_gate.sql` before it had been applied anywhere -- so the copy would
 * now mean CI proving something about a rewritten duplicate of the repository
 * instead of the repository. The manifest check below keeps the guard the copy
 * was there to provide: if a migration is added, edited or renamed without the
 * inventory being updated, start fails.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';

export const MANIFEST_PATH = 'supabase/tests/bootstrap-manifest.json';
export const MIGRATIONS_DIR = 'supabase/migrations';

/** The port supabase/config.toml pins the database to. */
export const LOCAL_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

export function hashOf(body) {
  return createHash('sha256').update(body).digest('hex').slice(0, 12);
}

/** Every migration in the repository, in the order the CLI applies them. */
export function currentMigrations({ readDir = readdirSync, readFile = readFileSync } = {}) {
  return readDir(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => ({ file, sha256: hashOf(readFile(`${MIGRATIONS_DIR}/${file}`, 'utf8')) }));
}

/**
 * Compare what is on disk against what was recorded.
 *
 * Reports every difference rather than the first: someone who added two
 * migrations should learn that in one run, not two.
 */
export function manifestDrift(recorded, actual) {
  const problems = [];
  const byFile = new Map(recorded.map((m) => [m.file, m.sha256]));

  for (const { file, sha256 } of actual) {
    if (!byFile.has(file)) {
      problems.push(`${file} is not in the manifest — add it and say why in the inventory`);
      continue;
    }
    if (byFile.get(file) !== sha256) {
      problems.push(`${file} changed (${byFile.get(file)} → ${sha256})`);
    }
    byFile.delete(file);
  }
  for (const file of byFile.keys()) {
    problems.push(`${file} is in the manifest but missing from ${MIGRATIONS_DIR}`);
  }

  const order = actual.map((m) => m.file).join(',');
  const recordedOrder = recorded.map((m) => m.file).join(',');
  if (!problems.length && order !== recordedOrder) {
    problems.push(`apply order changed:\n  recorded ${recordedOrder}\n  actual   ${order}`);
  }
  return problems;
}

/**
 * Refuse a CLI other than the one the baseline was proven on.
 *
 * A newer CLI ships newer auth, storage and postgres images. That is a
 * different baseline, and a green run against it says nothing about ours until
 * someone looks and re-records the version.
 */
export function cliDrift(recordedVersion, actualVersion) {
  if (!actualVersion) return 'the Supabase CLI is not installed or did not answer --version';
  if (actualVersion !== recordedVersion) {
    return `Supabase CLI ${actualVersion}, baseline recorded on ${recordedVersion}. `
      + `Re-run the local proof and update ${MANIFEST_PATH}, or install the pinned version.`;
  }
  return null;
}

export function startStack({
  run = spawnSync,
  readDir = readdirSync,
  readFile = readFileSync,
  log = console.log,
  error = console.error,
} = {}) {
  const manifest = JSON.parse(readFile(MANIFEST_PATH, 'utf8'));

  const version = run('supabase', ['--version'], { encoding: 'utf8' });
  const drift = cliDrift(manifest.cliVersion, (version.stdout ?? '').trim());
  if (drift) {
    error(drift);
    return 1;
  }

  const problems = manifestDrift(manifest.migrations, currentMigrations({ readDir, readFile }));
  if (problems.length) {
    error(`${MANIFEST_PATH} does not describe ${MIGRATIONS_DIR}:`);
    for (const p of problems) error(`  - ${p}`);
    error(`\nRe-record with: node ${process.argv[1]} write-manifest`);
    return 1;
  }

  log(`Supabase CLI ${manifest.cliVersion}, ${manifest.migrations.length} migrations verified.`);
  const started = run('supabase', ['start'], { stdio: 'inherit' });
  if (started.error) {
    error(`could not start the stack: ${started.error.message} (is Docker running?)`);
    return 1;
  }
  if (started.status !== 0) {
    error('supabase start failed — the SQL gates cannot run, and a skipped gate is not a passed gate.');
    return 1;
  }
  log(`\nStack up. Run the gates with VANSEN_LOCAL_DB=${LOCAL_DB_URL}`);
  return 0;
}

export function stopStack({ run = spawnSync, error = console.error } = {}) {
  // No --backup: this database exists to be thrown away, and keeping a dump of
  // it around invites someone to restore test fixtures over real work.
  const out = run('supabase', ['stop', '--no-backup'], { stdio: 'inherit' });
  if (out.error) {
    error(`could not stop the stack: ${out.error.message}`);
    return 1;
  }
  return out.status === 0 ? 0 : 1;
}

export function writeManifest({
  readDir = readdirSync,
  readFile = readFileSync,
  run = spawnSync,
  log = console.log,
} = {}) {
  const version = run('supabase', ['--version'], { encoding: 'utf8' });
  const manifest = {
    cliVersion: (version.stdout ?? '').trim(),
    recordedAt: new Date().toISOString().slice(0, 10),
    note: 'Regenerate with: node scripts/supabase-test-stack.mjs write-manifest',
    migrations: currentMigrations({ readDir, readFile }),
  };
  log(JSON.stringify(manifest, null, 2));
  return manifest;
}

export function main(argv, io = {}) {
  const command = argv[2] ?? 'start';
  if (command === 'start') return startStack(io);
  if (command === 'stop') return stopStack(io);
  if (command === 'write-manifest') {
    writeManifest(io);
    return 0;
  }
  (io.error ?? console.error)(`unknown command "${command}" — expected start, stop or write-manifest`);
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv));
}
