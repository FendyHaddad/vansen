#!/usr/bin/env node
// Read-only proof that what we say is deleted is deleted.
//
// The registry (`storage_objects`) claims to name every byte we hold. This
// script checks that claim against the stores themselves, in both directions:
//
//   orphan   — the store has an object the registry cannot name. Nobody could
//              ever delete it, because nothing knows it is there.
//   missing  — the registry says `live` or `held`, and the object is not there.
//   gone_but_present — the registry says `gone`. It is not. That is the exact
//              lie P6 exists to remove, and it is reported on its own.
//
// It NEVER deletes. It has no path that removes anything, by prefix or
// otherwise: a reconciler with a delete key is how a bug becomes data loss.
//
// A partial read cannot produce a clean result. Any bucket it could not fully
// enumerate, any page it could not fetch, any store it was not configured for
// makes the whole run fail — reporting "nothing orphaned" from half a listing
// would be worse than not running at all.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//   R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_BUCKET=... \
//   node scripts/storage-inventory.mjs [--json]

/** The only safe identity for an object: one key can exist in many buckets. */
export const objectKey = ({ backend, bucket, path }) => JSON.stringify([backend, bucket, path]);

/** Buckets this deployment writes to on Supabase. Mirrors api/services/object-storage.ts. */
export const SUPABASE_BUCKETS = ['media', 'uploads'];

const TABLE_PAGE = 1000;
const LIST_PAGE = 1000;

/**
 * Page a table in stable id order. Keyset, not offset: an offset walk over a
 * table something else is writing skips rows, and a skipped row here reads as
 * a deleted object.
 */
export async function pageTable(admin, table, columns, opts = {}) {
  const size = opts.pageSize ?? TABLE_PAGE;
  const out = [];
  let after = null;
  for (;;) {
    let query = admin.from(table).select(columns).order('id', { ascending: true }).limit(size);
    if (after !== null) query = query.gt('id', after);
    const { data, error } = await query;
    if (error) throw new Error(`read_failed ${table}: ${error.message}`);
    if (!data) throw new Error(`read_failed ${table}: no rows returned`);
    out.push(...data);
    if (data.length < size) return out;
    after = data[data.length - 1].id;
  }
}

/**
 * Every object in one Supabase bucket, folders included.
 *
 * `storage.list` returns one folder at a time and pages with limit/offset, so
 * this walks the tree and pages each level. A folder is a row with no `id`.
 */
export async function listSupabaseBucket(storage, bucket, opts = {}) {
  const size = opts.pageSize ?? LIST_PAGE;
  const found = [];
  const queue = [''];
  while (queue.length > 0) {
    const prefix = queue.shift();
    let offset = 0;
    for (;;) {
      const { data, error } = await storage.from(bucket).list(prefix, {
        limit: size,
        offset,
        sortBy: { column: 'name', order: 'asc' },
      });
      if (error) throw new Error(`list_failed ${bucket}/${prefix}: ${error.message}`);
      if (!data) throw new Error(`list_failed ${bucket}/${prefix}: no listing returned`);
      for (const entry of data) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        // A folder placeholder carries no id; anything else is an object.
        if (entry.id == null) queue.push(path);
        if (entry.id != null) found.push(path);
      }
      if (data.length < size) break;
      offset += data.length;
    }
  }
  return found;
}

/**
 * Every object in the R2 bucket, following the continuation token to the end.
 * A truncated listing that stops early is an error, never an empty tail.
 */
export async function listR2(r2, bucket) {
  const found = [];
  let token;
  for (;;) {
    const page = await r2.list({ bucket, continuationToken: token });
    if (!page || !Array.isArray(page.keys)) throw new Error('list_failed r2: no listing returned');
    found.push(...page.keys);
    if (!page.truncated) return found;
    if (!page.continuationToken) throw new Error('list_failed r2: truncated with no continuation');
    token = page.continuationToken;
  }
}

/** Locators the database says exist, keyed by [backend,bucket,path]. */
export function expectedFromRegistry(rows) {
  const expected = new Map();
  for (const row of rows) {
    expected.set(objectKey({ backend: row.backend, bucket: row.bucket, path: row.path }), {
      id: row.id,
      state: row.state,
      purpose: row.purpose,
      retainUntil: row.retain_until ?? null,
    });
  }
  return expected;
}

/**
 * Locators the CONTENT rows imply, so a row whose object was never registered
 * is caught. This is the pre-P6 state: a path referenced by a row and known to
 * nothing else.
 */
export function expectedFromSources({ generations = [], uploads = [], personas = [] }, r2Bucket) {
  const keys = new Map();
  const add = (backend, bucket, path, source) => {
    if (!path) return;
    if (backend === 'r2' && !bucket) throw new Error('r2_bucket_not_configured');
    keys.set(objectKey({ backend, bucket, path }), source);
  };
  for (const row of generations) {
    const backend = row.storage_backend ?? 'supabase';
    const bucket = backend === 'r2' ? r2Bucket : 'media';
    add(backend, bucket, row.media_path, `generations.media_path:${row.id}`);
    add(backend, bucket, row.thumb_path, `generations.thumb_path:${row.id}`);
  }
  for (const row of uploads) {
    add('supabase', 'uploads', row.path, `uploads.path:${row.id}`);
  }
  for (const row of personas) {
    for (const path of Object.values(row.photos ?? {})) {
      add('supabase', 'uploads', path, `personas.photos:${row.id}`);
    }
  }
  return keys;
}

/**
 * Compare the two sides. Each class of difference is counted separately: a
 * queued object that still exists is work in progress, not an orphan, and
 * folding them together would hide both.
 */
export function reconcile({ expected, sources, actual }) {
  const orphans = [];
  const missing = [];
  const goneButPresent = [];
  const queuedPresent = [];
  const heldPresent = [];
  const unregisteredSources = [];

  for (const key of actual) {
    const known = expected.get(key);
    if (!known) {
      orphans.push(key);
      continue;
    }
    if (known.state === 'gone') goneButPresent.push(key);
    if (known.state === 'delete_pending') queuedPresent.push(key);
    if (known.state === 'held') heldPresent.push(key);
  }
  const present = new Set(actual);
  for (const [key, known] of expected) {
    if (known.state !== 'live' && known.state !== 'held') continue;
    if (!present.has(key)) missing.push(key);
  }
  for (const [key, source] of sources) {
    if (!expected.has(key)) unregisteredSources.push({ key, source });
  }
  return { orphans, missing, goneButPresent, queuedPresent, heldPresent, unregisteredSources };
}

/**
 * The whole run. `deps` supplies the stores so the tests can drive it without
 * a network, and so a missing store is a configuration error rather than a
 * silently skipped half of the inventory.
 */
export async function runInventory(deps) {
  const { admin, listBucket, listR2Objects, r2Bucket } = deps;
  const buckets = deps.buckets ?? SUPABASE_BUCKETS;

  const registry = await pageTable(
    admin,
    'storage_objects',
    'id,backend,bucket,path,purpose,state,retain_until',
  );
  const outbox = await pageTable(admin, 'deletion_outbox', 'id,backend,bucket,object_path,completed_at,attempts,last_error');
  const generations = await pageTable(admin, 'generations', 'id,media_path,thumb_path,storage_backend');
  const uploads = await pageTable(admin, 'uploads', 'id,path');
  const personas = await pageTable(admin, 'personas', 'id,user_id,photos');
  const artifacts = await pageTable(admin, 'provider_artifact_deletions', 'id,provider,status,evidence_ref');

  const expected = expectedFromRegistry(registry);
  const sources = expectedFromSources({ generations, uploads, personas }, r2Bucket);

  const actual = [];
  const perBucket = {};
  for (const bucket of buckets) {
    const paths = await listBucket(bucket);
    perBucket[`supabase:${bucket}`] = paths.length;
    for (const path of paths) actual.push(objectKey({ backend: 'supabase', bucket, path }));
  }
  // R2 is inventoried whenever anything claims to live there. Skipping it
  // because the credentials are absent would report a clean local result
  // while every video sat unaccounted for.
  const needsR2 = [...expected.keys(), ...sources.keys()].some((k) => JSON.parse(k)[0] === 'r2');
  if (needsR2 && (!r2Bucket || !listR2Objects)) throw new Error('r2_not_configured');
  if (needsR2) {
    const keys = await listR2Objects(r2Bucket);
    perBucket[`r2:${r2Bucket}`] = keys.length;
    for (const path of keys) actual.push(objectKey({ backend: 'r2', bucket: r2Bucket, path }));
  }

  const differences = reconcile({ expected, sources, actual });
  const states = {};
  for (const row of registry) states[row.state] = (states[row.state] ?? 0) + 1;

  return {
    ...differences,
    counts: {
      registry: registry.length,
      objects: actual.length,
      perBucket,
      states,
      outboxPending: outbox.filter((r) => r.completed_at == null).length,
      outboxDeadLettered: outbox.filter((r) => r.completed_at == null && r.attempts >= 12).length,
    },
    // Provider-hosted artifacts are reported, never counted as removed: we do
    // not hold those bytes and cannot observe their absence.
    providerArtifacts: artifacts.reduce((acc, row) => {
      acc[row.status] = (acc[row.status] ?? 0) + 1;
      return acc;
    }, {}),
  };
}

/** Anything here means the inventory did not come out clean. */
export function failures(report) {
  return {
    orphans: report.orphans.length,
    missing: report.missing.length,
    goneButPresent: report.goneButPresent.length,
    unregisteredSources: report.unregisteredSources.length,
    outboxDeadLettered: report.counts.outboxDeadLettered,
  };
}

async function main() {
  const { createClient } = await import('@supabase/supabase-js');
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
    process.exit(2);
  }
  const admin = createClient(url, key);
  const r2Bucket = process.env.R2_BUCKET ?? null;

  let listR2Objects = null;
  if (r2Bucket) {
    const { S3Client, ListObjectsV2Command } = await import('@aws-sdk/client-s3');
    const client = new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    });
    listR2Objects = (bucket) =>
      listR2({
        list: async ({ continuationToken }) => {
          const res = await client.send(
            new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: continuationToken }),
          );
          return {
            keys: (res.Contents ?? []).map((o) => o.Key),
            truncated: Boolean(res.IsTruncated),
            continuationToken: res.NextContinuationToken,
          };
        },
      }, bucket);
  }

  const report = await runInventory({
    admin,
    listBucket: (bucket) => listSupabaseBucket(admin.storage, bucket),
    listR2Objects,
    r2Bucket,
  });

  const problems = failures(report);
  const total = Object.values(problems).reduce((a, b) => a + b, 0);
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  if (!process.argv.includes('--json')) {
    console.log('objects', JSON.stringify(report.counts, null, 2));
    console.log('provider artifacts', JSON.stringify(report.providerArtifacts));
    console.log('held (approved evidence retention)', report.heldPresent.length);
    console.log('queued for cleanup', report.queuedPresent.length);
    for (const [name, count] of Object.entries(problems)) {
      if (count > 0) console.error(`${name}: ${count}`);
    }
  }
  process.exit(total > 0 ? 1 : 0);
}

// Only run when executed, never when imported by the tests.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  await main().catch((e) => {
    // An incomplete inventory is a failure, not a clean report.
    console.error(String(e?.message ?? e));
    process.exit(2);
  });
}
