import { assertEquals, assertRejects } from 'jsr:@std/assert';
import { downloadBounded } from './store.ts';
import { MAX_VIDEO_BYTES, VIDEO_CONTENT_TYPES } from '../storage/index.ts';

function respond(
  body: Uint8Array | null,
  init: { status?: number; type?: string; length?: string | null } = {},
): typeof fetch {
  const headers = new Headers();
  if (init.type) headers.set('content-type', init.type);
  if (init.length !== null && init.length !== undefined) {
    headers.set('content-length', init.length);
  }
  return () =>
    Promise.resolve(
      new Response(body ? (body as BodyInit) : null, {
        status: init.status ?? 200,
        headers,
      }),
    );
}

/** A body that reports no length and keeps producing chunks. */
function endlessFetch(chunkBytes: number, chunks: number): typeof fetch {
  return () => {
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= chunks) return controller.close();
        sent++;
        controller.enqueue(new Uint8Array(chunkBytes));
      },
    });
    return Promise.resolve(
      new Response(stream, { headers: { 'content-type': 'video/mp4' } }),
    );
  };
}

const VIDEO = {
  allowedTypes: VIDEO_CONTENT_TYPES,
  maxBytes: MAX_VIDEO_BYTES,
  label: 'video',
};

Deno.test('returns the bytes and the declared type on success', async () => {
  const got = await downloadBounded('https://x/v.mp4', {
    ...VIDEO,
    fetchImpl: respond(new Uint8Array([1, 2, 3]), { type: 'video/mp4', length: '3' }),
  });
  assertEquals(got.bytes, new Uint8Array([1, 2, 3]));
  assertEquals(got.contentType, 'video/mp4');
});

Deno.test('an HTTP error never reaches storage', async () => {
  await assertRejects(
    () =>
      downloadBounded('https://x/v.mp4', {
        ...VIDEO,
        fetchImpl: respond(null, { status: 502 }),
      }),
    Error,
    'video fetch 502',
  );
});

Deno.test('a wrong content type is refused before the body is read', async () => {
  await assertRejects(
    () =>
      downloadBounded('https://x/v.mp4', {
        ...VIDEO,
        fetchImpl: respond(new Uint8Array([1]), { type: 'text/html', length: '1' }),
      }),
    Error,
    'unexpected video content type text/html',
  );
});

Deno.test('a content type with parameters still matches', async () => {
  const got = await downloadBounded('https://x/v.mp4', {
    ...VIDEO,
    fetchImpl: respond(new Uint8Array([9]), { type: 'video/mp4; codecs=avc1', length: '1' }),
  });
  assertEquals(got.contentType, 'video/mp4');
});

Deno.test('a zero-byte download is a failure, not an empty file', async () => {
  await assertRejects(
    () =>
      downloadBounded('https://x/v.mp4', {
        ...VIDEO,
        fetchImpl: respond(new Uint8Array(), { type: 'video/mp4', length: '0' }),
      }),
    Error,
    'video download was empty',
  );
});

Deno.test('a body shorter than content-length is a truncated transfer', async () => {
  await assertRejects(
    () =>
      downloadBounded('https://x/v.mp4', {
        ...VIDEO,
        fetchImpl: respond(new Uint8Array([1, 2]), { type: 'video/mp4', length: '99' }),
      }),
    Error,
    'truncated video',
  );
});

Deno.test('a declared length over the cap is refused and the body dropped', async () => {
  let cancelled = false;
  const fetchImpl: typeof fetch = () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(8));
      },
      cancel() {
        cancelled = true;
      },
    });
    return Promise.resolve(
      new Response(stream, {
        headers: { 'content-type': 'video/mp4', 'content-length': String(MAX_VIDEO_BYTES + 1) },
      }),
    );
  };
  await assertRejects(
    () => downloadBounded('https://x/v.mp4', { ...VIDEO, fetchImpl }),
    Error,
    'video too large',
  );
  // Never drained: the whole point is that an over-sized body is not buffered.
  assertEquals(cancelled, true, 'the over-sized body must be cancelled, not read');
});

Deno.test('a body over the cap with NO length is cut off mid-stream', async () => {
  await assertRejects(
    () =>
      downloadBounded('https://x/v.mp4', {
        ...VIDEO,
        maxBytes: 1024,
        fetchImpl: endlessFetch(512, 100),
      }),
    Error,
    'video exceeds byte budget',
  );
});

Deno.test('the fallback content type is used when the response declares none', async () => {
  const got = await downloadBounded('https://x/v.mp4', {
    ...VIDEO,
    fallbackContentType: 'video/webm',
    fetchImpl: respond(new Uint8Array([4]), { type: undefined, length: null }),
  });
  assertEquals(got.contentType, 'video/webm');
});

// ---------------------------------------------------------------- finishJob

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { FakeDb, type Row } from '../testing/fakes.ts';
import { finishJob, type FinishDeps, type FinishJob } from './store.ts';
import type { StorageAdapter } from '../storage/index.ts';

const JOB: FinishJob = { id: 'j0', user_id: 'u0', generation_id: 'g0', attempts: 0 };

interface Harness {
  db: FakeDb;
  deps: FinishDeps;
  r2: { puts: string[]; deletes: string[] };
  settles: Row[];
}

function harness(
  opts: { kind?: 'image' | 'video'; fetchImpl?: typeof fetch } = {},
): Harness {
  const db = new FakeDb();
  db.tables.generations = [
    { id: 'g0', user_id: 'u0', kind: opts.kind ?? 'image', status: 'pending', media_path: null, charged_plan: 40 },
  ];
  db.tables.jobs = [
    { id: 'j0', user_id: 'u0', generation_id: 'g0', claimed_at: null, attempts: 0, error: null },
  ];
  const settles: Row[] = [];
  db.rpcHandlers.fn_settle_job = (args, self) => {
    settles.push(args);
    const gen = (self.tables.generations ?? []).find((g) => g.id === 'g0');
    if (!gen || gen.status !== 'pending') {
      return { settled: false, previous: gen?.status ?? null, refunded: 0 };
    }
    if (args.p_outcome === 'done') {
      gen.status = 'done';
      gen.media_path = args.p_media_path;
      return { settled: true, previous: 'pending', refunded: 0 };
    }
    gen.status = 'failed';
    return { settled: true, previous: 'pending', refunded: Number(gen.charged_plan ?? 0) };
  };
  const r2 = { puts: [] as string[], deletes: [] as string[] };
  const adapter = {
    backend: 'r2',
    put: (path: string) => {
      r2.puts.push(path);
      return Promise.resolve();
    },
    delete: (path: string) => {
      r2.deletes.push(path);
      return Promise.resolve();
    },
    signedUrl: () => Promise.resolve('https://fake.r2/o'),
  } as unknown as StorageAdapter;
  return {
    db,
    r2,
    settles,
    deps: {
      admin: db as unknown as SupabaseClient,
      storageFor: () => adapter,
      fetch: opts.fetchImpl,
    },
  };
}

function urlResult(url = 'https://cdn/x') {
  return { state: 'done' as const, url, contentType: 'image/png' };
}

function inlineResult(bytes: Uint8Array, contentType = 'image/png') {
  return { state: 'done' as const, bytes, contentType };
}

function mediaKeys(db: FakeDb): string[] {
  return [...db.storage.objects.keys()].filter((k) => k.startsWith('media/'));
}

Deno.test('a download that 404s retries the job instead of settling it', async () => {
  const h = harness({ fetchImpl: () => Promise.resolve(new Response(null, { status: 404 })) });
  await finishJob(h.deps, JOB, urlResult());
  assertEquals(h.settles.length, 0, 'a failed download must not refund');
  assertEquals(h.db.tables.jobs[0].attempts, 1);
  assertEquals(h.db.tables.jobs[0].claimed_at, null);
  assertEquals(h.db.tables.generations[0].status, 'pending');
});

Deno.test('an image generation refuses a video download', async () => {
  const h = harness({
    fetchImpl: () =>
      Promise.resolve(new Response(new Uint8Array([1]), { headers: { 'content-type': 'video/mp4' } })),
  });
  await finishJob(h.deps, JOB, urlResult());
  assertEquals(mediaKeys(h.db), []);
  assertEquals(h.settles.length, 0);
  assertEquals(h.db.tables.jobs[0].attempts, 1);
});

Deno.test('a video generation stores to r2 under a video key', async () => {
  const h = harness({
    kind: 'video',
    fetchImpl: () =>
      Promise.resolve(
        new Response(new Uint8Array([1, 2]), {
          headers: { 'content-type': 'video/mp4', 'content-length': '2' },
        }),
      ),
  });
  await finishJob(h.deps, JOB, { state: 'done', url: 'https://cdn/v', contentType: 'video/mp4' });
  assertEquals(h.r2.puts, ['videos/u0/g0-0.mp4']);
  assertEquals(h.db.tables.generations[0].status, 'done');
  assertEquals(h.settles[0].p_backend, 'r2');
});

Deno.test('a truncated download never reaches storage', async () => {
  const h = harness({
    fetchImpl: () =>
      Promise.resolve(
        new Response(new Uint8Array([1]), {
          headers: { 'content-type': 'image/png', 'content-length': '900' },
        }),
      ),
  });
  await finishJob(h.deps, JOB, urlResult());
  assertEquals(mediaKeys(h.db), []);
  assertEquals(h.settles.length, 0);
});

Deno.test('an empty inline payload fails the job and refunds', async () => {
  const h = harness();
  await finishJob(h.deps, JOB, inlineResult(new Uint8Array()));
  assertEquals(mediaKeys(h.db), []);
  assertEquals(h.settles[0].p_outcome, 'failed');
  assertEquals(h.db.tables.generations[0].status, 'failed');
});

Deno.test('a storage write failure fails the job and refunds', async () => {
  const h = harness();
  h.db.storage.failNext('media.upload', 'bucket is read-only');
  await finishJob(h.deps, JOB, inlineResult(new Uint8Array([1, 2, 3])));
  assertEquals(mediaKeys(h.db), []);
  assertEquals(h.settles[0].p_outcome, 'failed');
  assertEquals(h.settles[0].p_error, 'store_failed');
});

Deno.test('an unknown settlement keeps the object and releases the claim', async () => {
  const h = harness({
    fetchImpl: () =>
      Promise.resolve(
        new Response(new Uint8Array([1]), {
          headers: { 'content-type': 'image/png', 'content-length': '1' },
        }),
      ),
  });
  h.db.rpcHandlers.fn_settle_job = () => {
    throw new Error('connection reset');
  };
  await finishJob(h.deps, JOB, urlResult());
  // Unknown is not lost: a done row may already point at these bytes.
  assertEquals(mediaKeys(h.db).length, 1);
  assertEquals(h.db.tables.jobs[0].claimed_at, null);
  assertEquals(h.db.tables.jobs[0].phase, 'rendering');
});

Deno.test('a stale lease loses the race and its object is dropped', async () => {
  const h = harness();
  // What a stale lease looks like from here: the RPC refuses and reports who won.
  h.db.rpcHandlers.fn_settle_job = () => ({ settled: false, previous: 'failed', refunded: 40 });
  await finishJob(h.deps, { ...JOB, lease_token: 'expired' }, inlineResult(new Uint8Array([1])));
  assertEquals(h.settles.length, 0, 'the stub replaced the recorder');
  assertEquals(mediaKeys(h.db), []);
});

Deno.test('the lease token is handed to the settlement', async () => {
  const h = harness();
  await finishJob(h.deps, { ...JOB, lease_token: 'tok-1' }, inlineResult(new Uint8Array([1])));
  assertEquals(h.settles[0].p_lease_token, 'tok-1');
});

Deno.test('a losing attempt can neither overwrite nor delete the winner object', async () => {
  const h = harness();
  // The winner settled first, from an earlier attempt, under its own key.
  await finishJob(h.deps, { ...JOB, attempts: 0 }, inlineResult(new Uint8Array([1])));
  const winner = mediaKeys(h.db);
  assertEquals(winner, ['media/u0/g0-0.png']);

  await finishJob(h.deps, { ...JOB, attempts: 1 }, inlineResult(new Uint8Array([9, 9])));

  assertEquals(mediaKeys(h.db), winner, "the winner's object must survive untouched");
  assertEquals(h.db.tables.generations[0].media_path, 'u0/g0-0.png');
  assertEquals(h.db.storage.objects.get('media/u0/g0-0.png')?.bytes.length, 1);
});

Deno.test('an orphan check that cannot read the row keeps the object', async () => {
  const h = harness();
  // Armed at settlement time so the failure lands on the orphan check itself,
  // not on the earlier read of the generation's kind.
  h.db.rpcHandlers.fn_settle_job = () => {
    h.db.failNext('generations.select', 'connection reset');
    return { settled: false, previous: 'failed', refunded: 40 };
  };
  await finishJob(h.deps, JOB, inlineResult(new Uint8Array([1])));
  // Deleting on an unverified read is how a winner's media gets destroyed.
  assertEquals(mediaKeys(h.db).length, 1);
});

Deno.test('the last allowed attempt fails the job instead of retrying forever', async () => {
  const h = harness({ fetchImpl: () => Promise.resolve(new Response(null, { status: 500 })) });
  await finishJob(h.deps, { ...JOB, attempts: 2 }, urlResult());
  assertEquals(h.settles[0].p_outcome, 'failed');
  assertEquals(h.settles[0].p_error, 'store_failed');
});

Deno.test('a retryable check leaves the job pending with no error recorded', async () => {
  const h = harness();
  await finishJob(h.deps, JOB, { state: 'retryable_failure', error: 'fal status 429' });
  assertEquals(h.settles.length, 0);
  assertEquals(h.db.tables.jobs[0].error, null, 'jobs_pending_idx is where error is null');
  assertEquals(h.db.tables.generations[0].status, 'pending');
});

Deno.test('a second poller finds the job already claimed and does nothing', async () => {
  const h = harness({ fetchImpl: () => Promise.reject(new Error('must not download')) });
  h.db.tables.jobs[0].claimed_at = '2026-09-20T00:00:00Z';
  await finishJob(h.deps, JOB, urlResult());
  assertEquals(h.settles.length, 0);
  assertEquals(mediaKeys(h.db), []);
});

Deno.test('a re-run of the winning attempt keeps its own object', async () => {
  // The settlement landed but its answer was lost, so the same attempt runs
  // again and writes the same key. Losing the second race must not delete the
  // object the `done` row points at.
  const h = harness();
  await finishJob(h.deps, JOB, inlineResult(new Uint8Array([1])));
  assertEquals(h.db.tables.generations[0].media_path, 'u0/g0-0.png');

  await finishJob(h.deps, JOB, inlineResult(new Uint8Array([1])));

  assertEquals(mediaKeys(h.db), ['media/u0/g0-0.png'], 'the done row still points here');
});

Deno.test('a body LONGER than its declared length is refused mid-stream', async () => {
  const fetchImpl: typeof fetch = () => {
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent++;
        if (sent > 4) return controller.close();
        controller.enqueue(new Uint8Array(16));
      },
    });
    return Promise.resolve(
      new Response(stream, {
        headers: { 'content-type': 'video/mp4', 'content-length': '16' },
      }),
    );
  };
  await assertRejects(
    () => downloadBounded('https://x/v.mp4', { ...VIDEO, fetchImpl }),
    Error,
    'video exceeds byte budget',
  );
});
