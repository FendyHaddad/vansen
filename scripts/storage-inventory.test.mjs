// The inventory is the thing that decides whether "deleted" was true. These
// tests exist to prove it cannot say "clean" from a partial read.
//
//   node --test scripts/storage-inventory.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  expectedFromSources,
  failures,
  listR2,
  listSupabaseBucket,
  objectKey,
  pageTable,
  reconcile,
  runInventory,
} from './storage-inventory.mjs';

const R2_BUCKET = 'vansen-media';

/** A Supabase-shaped client over plain arrays, with paging that really pages. */
function fakeAdmin(tables, opts = {}) {
  return {
    from(table) {
      const query = {
        _after: null,
        _limit: 1000,
        select() {
          return query;
        },
        order() {
          return query;
        },
        limit(n) {
          query._limit = n;
          return query;
        },
        gt(_col, value) {
          query._after = value;
          return query;
        },
        then(resolve) {
          if (opts.failTable === table) {
            return resolve({ data: null, error: { message: 'permission denied' } });
          }
          const rows = [...(tables[table] ?? [])].sort((a, b) => (a.id < b.id ? -1 : 1));
          const start = query._after === null
            ? 0
            : rows.findIndex((r) => r.id > query._after);
          const page = start === -1 ? [] : rows.slice(start, start + query._limit);
          return resolve({ data: page, error: null });
        },
      };
      return query;
    },
  };
}

/** A storage listing with real folders, real paging and injectable failures. */
function fakeStorage(objects, opts = {}) {
  return {
    from(bucket) {
      return {
        async list(prefix, { limit, offset }) {
          if (opts.failBucket === bucket) {
            return { data: null, error: { message: 'permission denied' } };
          }
          const head = prefix ? `${prefix}/` : '';
          const names = new Map();
          for (const path of objects[bucket] ?? []) {
            if (!path.startsWith(head)) continue;
            const rest = path.slice(head.length);
            const cut = rest.indexOf('/');
            if (cut === -1) names.set(rest, { name: rest, id: `id-${path}` });
            if (cut !== -1) names.set(rest.slice(0, cut), { name: rest.slice(0, cut), id: null });
          }
          const sorted = [...names.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
          const page = sorted.slice(offset, offset + limit);
          // Page two is unreadable in this mode: a run that reports "clean"
          // from page one alone has not inventoried anything.
          if (opts.failSecondPage && offset > 0) {
            return { data: null, error: { message: 'timeout' } };
          }
          return { data: page, error: null };
        },
      };
    },
  };
}

function registryRow(over) {
  return {
    id: over.path,
    backend: 'supabase',
    bucket: 'media',
    purpose: 'media',
    state: 'live',
    retain_until: null,
    ...over,
  };
}

// ------------------------------------------------------------------- keying

test('a key is the whole locator, not the path', () => {
  const a = objectKey({ backend: 'supabase', bucket: 'media', path: 'u/a.png' });
  const b = objectKey({ backend: 'supabase', bucket: 'uploads', path: 'u/a.png' });
  const c = objectKey({ backend: 'r2', bucket: R2_BUCKET, path: 'u/a.png' });
  assert.equal(new Set([a, b, c]).size, 3);
});

// ------------------------------------------------------------------- paging

test('a table larger than one page is fully enumerated', async () => {
  const personas = Array.from({ length: 2500 }, (_, i) => ({
    id: `p${String(i).padStart(5, '0')}`,
    user_id: 'u1',
    photo_paths: [],
  }));
  const rows = await pageTable(fakeAdmin({ personas }), 'personas', 'id', { pageSize: 1000 });
  assert.equal(rows.length, 2500);
  assert.equal(new Set(rows.map((r) => r.id)).size, 2500);
});

test('a folder with more than one page of objects is fully enumerated', async () => {
  const paths = Array.from({ length: 1200 }, (_, i) => `u1/${String(i).padStart(5, '0')}.png`);
  const found = await listSupabaseBucket(fakeStorage({ media: paths }), 'media', { pageSize: 1000 });
  assert.equal(found.length, 1200);
});

test('nested folders are walked, not just the root', async () => {
  const paths = ['u1/a.png', 'u1/nested/b.png', 'quarantine/u1/c.png'];
  const found = await listSupabaseBucket(fakeStorage({ uploads: paths }), 'uploads');
  assert.deepEqual(found.sort(), paths.sort());
});

test('a listing error is raised, never read as an empty bucket', async () => {
  await assert.rejects(
    () => listSupabaseBucket(fakeStorage({ media: ['u1/a.png'] }, { failBucket: 'media' }), 'media'),
    /list_failed/,
  );
});

test('a page we could not read fails the whole enumeration', async () => {
  const paths = Array.from({ length: 1500 }, (_, i) => `u1/${String(i).padStart(5, '0')}.png`);
  await assert.rejects(
    () =>
      listSupabaseBucket(fakeStorage({ media: paths }, { failSecondPage: true }), 'media', {
        pageSize: 1000,
      }),
    /list_failed/,
  );
});

test('R2 is followed to the end of its continuation tokens', async () => {
  const pages = [
    { keys: ['videos/a.mp4'], truncated: true, continuationToken: 't1' },
    { keys: ['videos/b.mp4'], truncated: true, continuationToken: 't2' },
    { keys: ['videos/c.mp4'], truncated: false },
  ];
  let seen = 0;
  const keys = await listR2({ list: async () => pages[seen++] }, R2_BUCKET);
  assert.deepEqual(keys, ['videos/a.mp4', 'videos/b.mp4', 'videos/c.mp4']);
});

test('a truncated R2 listing with no token is an error', async () => {
  await assert.rejects(
    () => listR2({ list: async () => ({ keys: [], truncated: true }) }, R2_BUCKET),
    /truncated with no continuation/,
  );
});

// -------------------------------------------------------------- reconciling

test('the same key in two buckets is two objects', () => {
  const expected = new Map([
    [objectKey({ backend: 'supabase', bucket: 'media', path: 'u1/a.png' }), { state: 'live' }],
  ]);
  const report = reconcile({
    expected,
    sources: new Map(),
    actual: [
      objectKey({ backend: 'supabase', bucket: 'media', path: 'u1/a.png' }),
      objectKey({ backend: 'supabase', bucket: 'uploads', path: 'u1/a.png' }),
    ],
  });
  assert.equal(report.orphans.length, 1);
  assert.match(report.orphans[0], /uploads/);
  assert.equal(report.missing.length, 0);
});

test('a queued object that still exists is work in progress, not an orphan', () => {
  const key = objectKey({ backend: 'supabase', bucket: 'media', path: 'u1/a.png' });
  const report = reconcile({
    expected: new Map([[key, { state: 'delete_pending' }]]),
    sources: new Map(),
    actual: [key],
  });
  assert.deepEqual(report.orphans, []);
  assert.deepEqual(report.queuedPresent, [key]);
});

test('an object the registry calls gone is reported on its own', () => {
  const key = objectKey({ backend: 'supabase', bucket: 'media', path: 'u1/a.png' });
  const report = reconcile({
    expected: new Map([[key, { state: 'gone' }]]),
    sources: new Map(),
    actual: [key],
  });
  assert.deepEqual(report.goneButPresent, [key]);
  assert.deepEqual(report.orphans, []);
});

test('held evidence is counted as held, and never as missing or orphaned', () => {
  const key = objectKey({ backend: 'supabase', bucket: 'uploads', path: 'quarantine/u1/e.png' });
  const report = reconcile({
    expected: new Map([[key, { state: 'held' }]]),
    sources: new Map(),
    actual: [key],
  });
  assert.deepEqual(report.heldPresent, [key]);
  assert.deepEqual(report.orphans, []);
  assert.deepEqual(report.missing, []);
});

test('a row whose object was never registered is named with its source', () => {
  const sources = expectedFromSources(
    { uploads: [{ id: 'up1', path: 'u1/a.png' }] },
    R2_BUCKET,
  );
  const report = reconcile({ expected: new Map(), sources, actual: [] });
  assert.equal(report.unregisteredSources.length, 1);
  assert.equal(report.unregisteredSources[0].source, 'uploads.path:up1');
});

test('an R2 generation with no configured bucket is refused, not assumed', () => {
  assert.throws(
    () =>
      expectedFromSources(
        { generations: [{ id: 'g1', media_path: 'videos/a.mp4', storage_backend: 'r2' }] },
        null,
      ),
    /r2_bucket_not_configured/,
  );
});

// -------------------------------------------------------------- the whole run

function fullSetup(over = {}) {
  const tables = {
    storage_objects: [
      registryRow({ path: 'u1/live.png' }),
      registryRow({ path: 'u1/queued.png', state: 'delete_pending' }),
      registryRow({ path: 'u1/removed.png', state: 'gone' }),
      registryRow({
        id: 'ev',
        bucket: 'uploads',
        path: 'quarantine/u1/e.png',
        purpose: 'quarantine',
        state: 'held',
      }),
      registryRow({
        id: 'vid',
        backend: 'r2',
        bucket: R2_BUCKET,
        path: 'videos/u1/v.mp4',
      }),
    ],
    deletion_outbox: [{
      id: 'd1',
      backend: 'supabase',
      bucket: 'media',
      object_path: 'u1/queued.png',
      completed_at: null,
      attempts: 1,
    }],
    generations: [{
      id: 'g1',
      media_path: 'u1/live.png',
      thumb_path: null,
      storage_backend: 'supabase',
    }],
    uploads: [],
    personas: [],
    provider_artifact_deletions: [
      { id: 'a1', provider: 'fal', status: 'requested', evidence_ref: null },
    ],
    ...over.tables,
  };
  const objects = {
    media: ['u1/live.png', 'u1/queued.png'],
    uploads: ['quarantine/u1/e.png'],
    ...over.objects,
  };
  const storage = fakeStorage(objects, over.storageOpts);
  return {
    admin: fakeAdmin(tables, over.adminOpts),
    listBucket: (bucket) => listSupabaseBucket(storage, bucket),
    listR2Objects: over.listR2Objects ?? (async () => over.r2Keys ?? ['videos/u1/v.mp4']),
    r2Bucket: 'r2Bucket' in over ? over.r2Bucket : R2_BUCKET,
  };
}

test('a healthy deployment reports clean, with each class counted separately', async () => {
  const report = await runInventory(fullSetup());

  assert.deepEqual(failures(report), {
    orphans: 0,
    missing: 0,
    goneButPresent: 0,
    unregisteredSources: 0,
    outboxDeadLettered: 0,
  });
  assert.deepEqual(report.queuedPresent.length, 1);
  assert.deepEqual(report.heldPresent.length, 1);
  assert.equal(report.counts.perBucket['supabase:media'], 2);
  assert.equal(report.counts.perBucket[`r2:${R2_BUCKET}`], 1);
  assert.deepEqual(report.providerArtifacts, { requested: 1 });
});

test('an object nothing knows about is an orphan, wherever it lives', async () => {
  const report = await runInventory(fullSetup({
    objects: { media: ['u1/live.png', 'u1/queued.png', 'u1/stray.png'] },
    r2Keys: ['videos/u1/v.mp4', 'videos/u1/stray.mp4'],
  }));

  assert.equal(report.orphans.length, 2);
  assert.equal(failures(report).orphans, 2);
});

test('a registered object that is not there is missing, not silently fine', async () => {
  const report = await runInventory(fullSetup({ objects: { media: ['u1/queued.png'] } }));
  assert.deepEqual(report.missing, [
    objectKey({ backend: 'supabase', bucket: 'media', path: 'u1/live.png' }),
  ]);
});

test('an object the registry called gone fails the run', async () => {
  const report = await runInventory(fullSetup({
    objects: { media: ['u1/live.png', 'u1/queued.png', 'u1/removed.png'] },
  }));
  assert.equal(failures(report).goneButPresent, 1);
});

test('a dead-lettered deletion fails the run', async () => {
  const report = await runInventory(fullSetup({
    tables: {
      deletion_outbox: [{
        id: 'd1',
        backend: 'supabase',
        bucket: 'media',
        object_path: 'u1/queued.png',
        completed_at: null,
        attempts: 12,
      }],
    },
  }));
  assert.equal(failures(report).outboxDeadLettered, 1);
});

test('an R2 object we are not configured to read fails the run', async () => {
  await assert.rejects(
    () => runInventory(fullSetup({ r2Bucket: null, listR2Objects: null })),
    /r2_not_configured/,
  );
});

test('a table we cannot read fails the run', async () => {
  await assert.rejects(
    () => runInventory(fullSetup({ adminOpts: { failTable: 'storage_objects' } })),
    /read_failed storage_objects/,
  );
});

test('a bucket whose second page is unreadable fails the run', async () => {
  const many = Array.from({ length: 1500 }, (_, i) => `u1/${String(i).padStart(5, '0')}.png`);
  await assert.rejects(
    () =>
      runInventory(fullSetup({
        objects: { media: many },
        storageOpts: { failSecondPage: true },
      })),
    /list_failed/,
  );
});
