#!/usr/bin/env node
/**
 * The SQL gate: every `supabase/tests/*.sql` file and every `*.sh` concurrency
 * harness, against a local database, in one pass.
 *
 * These are the only tests that exercise the real thing. A fake database
 * agrees with whatever the code believes; Postgres does not, and every defect
 * P2, P4, P5 and P6 fixed was one the fakes had been happily passing.
 *
 * Two rules are enforced here rather than trusted:
 *   - The target must be local. These files INSERT, UPDATE and DELETE; pointed
 *     at the hosted project they would destroy customer data.
 *   - The schema must actually be there. A database missing `cron.job` or
 *     `pg_net` runs some of the suite, passes, and proves nothing.
 */
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const DIRECTORY = 'supabase/tests';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * The baseline every suite assumes. `pg_net` is checked as an extension rather
 * than by calling `net.http_post`, whose signature has changed between
 * versions -- a probe that fails on an argument name would look like a missing
 * database.
 */
const PREFLIGHT = `
  select 1 / case when to_regclass('auth.users') is not null
                   and to_regclass('storage.objects') is not null
                   and to_regclass('cron.job') is not null
                   and exists (select 1 from pg_extension where extname = 'pg_net')
              then 1 else 0 end`;

/** Injected so the retained tests can drive this without a database. */
export function runSqlTests({
  env = process.env,
  readDir = readdirSync,
  run = spawnSync,
  log = console.log,
} = {}) {
  const connection = env.VANSEN_LOCAL_DB;
  if (!connection) {
    throw new Error('VANSEN_LOCAL_DB is required; the SQL gate cannot be skipped');
  }

  // Never interpolated into a message: a connection string carries a password.
  const address = new URL(connection);
  if (!LOCAL_HOSTS.has(address.hostname)) {
    throw new Error('the SQL gate requires a disposable local database');
  }

  const files = readDir(DIRECTORY).filter((f) => /\.(sql|sh)$/.test(f)).sort();
  if (!files.some((f) => f.endsWith('.sql'))) {
    throw new Error('no SQL tests discovered');
  }

  const execute = (command, args) => {
    const result = run(command, args, { stdio: 'inherit', shell: false });
    if (result.error) throw new Error(`SQL gate could not start ${command}`);
    if (result.signal) throw new Error(`SQL gate: ${command} killed by ${result.signal}`);
    if (result.status !== 0) throw new Error(`SQL gate failed: ${command}`);
  };

  execute('psql', [connection, '-X', '-v', 'ON_ERROR_STOP=1', '-q', '-c', PREFLIGHT]);

  for (const file of files) {
    log('SQL gate:', file);
    if (file.endsWith('.sh')) {
      execute('bash', [`${DIRECTORY}/${file}`]);
      continue;
    }
    execute('psql', [connection, '-X', '-v', 'ON_ERROR_STOP=1', '-q', '-f', `${DIRECTORY}/${file}`]);
  }

  log(`SQL gate: ${files.length} file(s) passed`);
  return files;
}

// `node scripts/run-sql-tests.mjs` runs it; importing it does not.
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    runSqlTests();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
