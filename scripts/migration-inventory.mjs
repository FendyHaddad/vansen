#!/usr/bin/env node
/**
 * Repository migration filenames only.
 *
 * Renaming a migration the database has already recorded breaks the very
 * ledger that says what ran, so this script records a collision rather than
 * resolving one -- and fails only on a NEW collision, which is the one nobody
 * has decided about yet.
 *
 * What this does NOT do: prove anything about the deployed database. The
 * mapping from these filenames to `supabase_migrations.schema_migrations`
 * lives in docs/superpowers/specs/2026-09-20-migration-inventory.md and comes
 * from a read-only query, not from this file. A green exit here is a statement
 * about the repository and nothing else.
 */
import { readdirSync } from 'node:fs';

/**
 * Collisions that have been looked at and recorded.
 *
 * Empty as of 2026-09-22: `0008_age_gate.sql` was renamed `00091_age_gate.sql`
 * BEFORE it was ever applied anywhere (the remote ledger had no `0008` row for
 * it), which is why that rename was safe and is not an exception to the rule
 * above.
 */
const ACCEPTED_DUPLICATES = new Set();

/**
 * The version is everything before the first underscore, which is what the
 * Supabase CLI records and orders by. Reading a fixed four characters instead
 * would call `00091_age_gate.sql` and `0009_pending_plan_change.sql` the same
 * migration -- they are not, and treating them as one would mean "fixing" a
 * collision that does not exist by renaming a file that is already applied.
 */
export function versionOf(file) {
  const underscore = file.indexOf('_');
  return underscore === -1 ? file.replace(/\.sql$/, '') : file.slice(0, underscore);
}

export function inventory({ readDir = readdirSync, log = console.log } = {}) {
  const files = readDir('supabase/migrations').filter((f) => f.endsWith('.sql')).sort();

  const byPrefix = new Map();
  for (const file of files) {
    const prefix = versionOf(file);
    byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), file]);
  }

  const duplicates = [...byPrefix.entries()].filter(([, list]) => list.length > 1);
  const unexpected = duplicates.filter(([prefix]) => !ACCEPTED_DUPLICATES.has(prefix));

  for (const [prefix, list] of duplicates) {
    const tag = ACCEPTED_DUPLICATES.has(prefix) ? 'known' : 'NEW';
    log(`${tag} duplicate prefix ${prefix}: ${list.join(', ')}`);
  }

  log(`${files.length} migration files, ${duplicates.length} duplicate prefix group(s)`);
  return { files, duplicates, unexpected };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { unexpected } = inventory();
  process.exit(unexpected.length ? 1 : 0);
}
