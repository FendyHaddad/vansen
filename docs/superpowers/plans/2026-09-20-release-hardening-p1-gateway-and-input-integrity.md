# Release Hardening P1 — Gateway Test Harness and Input Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every `api` gateway route testable without a network or a database, then close the input holes: unchecked upload references, moderation that fails open, missing family-level settings validation, and the upload-as-reference path that is rejected before it reaches any provider.

**Architecture:** `supabase/functions/api/index.ts` is split into `app.ts` (`createApp(deps)` returns a Hono app) and `index.ts` (composes production dependencies, calls `Deno.serve`). All route bodies move unchanged — they already reference `admin`, `stripe`, `moderate`, `adapterFor` and `storageFor` as free identifiers, so destructuring those names from `deps` at the top of `createApp` requires zero edits inside the bodies. Tests build the app with in-memory fakes and drive it through `app.request(...)`. On top of that seam: moderation becomes a three-state decision that fails closed, uploads gain a server-side ownership registry, and every user-supplied reference is resolved through one owner-checked resolver.

**Tech Stack:** Deno, Hono (`jsr:@hono/hono`), `jsr:@supabase/supabase-js@2`, Postgres, `deno test`; Angular 22 + vitest for the one client-side change.

**Source spec:** `docs/superpowers/plans/2026-09-17-release-readiness-review-and-implementation-plan.md` — this plan implements **T01** and **T02**, closing findings **R01, R10, R28**, the validation half of **R09**, and the test-seam and 204 halves of **R27**.

## Global Constraints

- **Never commit, branch, or push.** Every task ends with "user commits" — the user makes all commits personally. No `git commit` steps anywhere in this plan.
- **No nested if statements.** Guard clauses and early returns only.
- **Angular components always use separate files** `.ts` + `.html` + `.css`. Never inline templates or styles.
- **Migration numbering:** the highest file on disk is `0016_video.sql`, whose deployed state is **unverified** (the historical note in `vansen.md` is not current evidence). `0008_age_gate.sql` and `0008_credit_plans.sql` share a prefix. Before adding `0017_*`, run the deployed-migration inventory in Step 1 of Task 6 and confirm with the user. Never renumber an applied migration.
- **Tables are RLS deny-all; RPCs are service_role-only.** Every new RPC gets `revoke execute … from public, anon, authenticated; grant execute … to service_role;`.
- **Moderation runs BEFORE charge and BEFORE any provider call**, on the prompt and on every image. After this plan it also fails **closed**.
- **Provider/service-role keys only in Edge Function secrets.** No keys in the repo, no keys in tests (tests never call a real provider).
- **Tests:** Edge → `cd supabase/functions && deno test --allow-all _shared api`. Angular → `npm test -- --watch=false` from the repo root (never bare `npx vitest run` — it falsely fails TestBed specs). Build → `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use 22.23.1 >/dev/null && npx ng build`.
- **Baseline counts before this plan:** 40 deno tests (all under `_shared`), 239 vitest tests, 42 vitest files. Every task states the new expected count.
- **Deploy is not part of this plan.** No `supabase functions deploy`, no `apply_migration` against production. Migrations are written to disk and applied only to a local/synthetic database.
- **Error copy is user-visible.** Use the exact strings given in each step; they are referenced by tests.

---

## File Structure

**New — test harness:**
- `supabase/functions/api/testing/fakes.ts` — in-memory `FakeDb` (PostgREST-shaped query builder), `FakeStorage`, fake provider adapter, fake moderation, and `testDeps()` which assembles them into an `ApiDeps`.
- `supabase/functions/api/testing/fakes_test.ts` — proves the fake behaves like PostgREST for the operations the gateway uses.

**New — gateway seam:**
- `supabase/functions/api/app.ts` — `ApiDeps` interface + `createApp(deps)`. Receives every route body moved verbatim out of `index.ts`.
- `supabase/functions/api/app_test.ts` — route characterization tests (auth, age gate, malformed JSON, foreign row, 204).

**Modified:**
- `supabase/functions/api/index.ts` — shrinks to production dependency composition + `Deno.serve(createApp(deps).fetch)`.
- `supabase/functions/_shared/moderation.ts` — returns `ModerationDecision`; fails closed.
- `src/app/core/api/api-service.ts` — handles 204.
- `src/app/features/workspace/workspace-page.ts` — an uploaded reference no longer forces `op=edit`.

**New — input integrity:**
- `supabase/functions/_shared/moderation_test.ts` — decision-state tests.
- `supabase/functions/_shared/image-size.ts` + `image-size_test.ts` — PNG/JPEG/WebP dimension sniffing for the pre-allocation limit.
- `supabase/functions/api/services/reference-resolver.ts` + `reference-resolver_test.ts` — `resolveOwnedUpload()` / `resolveOwnedParentImage()`.
- `supabase/functions/api/services/request-validation.ts` + `request-validation_test.ts` — family-level settings validation.
- `supabase/migrations/0017_upload_registry.sql` — `uploads` table recording owner, purpose, MIME, bytes, dimensions and moderation state.

---

## Task 1: In-memory fakes for the gateway

**Files:**
- Create: `supabase/functions/api/testing/fakes.ts`
- Test: `supabase/functions/api/testing/fakes_test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `class FakeDb` with `tables: Record<string, Row[]>`, `rpcHandlers: Record<string, (args: Row, db: FakeDb) => unknown>`, `rpcCalls: {name: string; args: Row}[]`, `failNext(key: string, message: string, code?: string): void`, `from(table)`, `rpc(name, args)`, `auth`, and `storage` (a `FakeStorage`).
  - `class FakeStorage` with `objects: Map<string, StoredObject>`, `failNext(key: string, message: string): void`, `from(bucket)`.
  - `function fakeAdapter(opts?): { adapter: ProviderAdapter; submits: SubmitCtx[]; checks: string[]; cancels: string[] }`
  - `function fakeModeration(): { moderate: Moderate; calls: {text?: string; imageUrl?: string}[]; next: (d: ModerationDecision) => void }`
  - `function testDeps(over?: Partial<ApiDeps>): ApiDeps` — assembled dependencies with a seeded user.
  - `const TEST_USER = '11111111-1111-4111-8111-111111111111'` and `const OTHER_USER = '22222222-2222-4222-8222-222222222222'`.

`ApiDeps` does not exist yet — Task 2 creates it. In this task `testDeps()` returns a plain object typed `Record<string, unknown>`; Task 2 Step 5 re-types it. That is the only forward reference in this plan.

- [ ] **Step 1: Write the failing test**

Create `supabase/functions/api/testing/fakes_test.ts`:

```ts
import { assertEquals } from 'jsr:@std/assert';
import { FakeDb, FakeStorage, TEST_USER } from './fakes.ts';

Deno.test('select + eq + maybeSingle returns the matching row', async () => {
  const db = new FakeDb();
  db.tables.profiles = [
    { id: TEST_USER, birth_date: '1990-01-01', strikes: 0 },
    { id: 'other', birth_date: null, strikes: 0 },
  ];
  const { data, error } = await db.from('profiles').select('birth_date').eq('id', TEST_USER).maybeSingle();
  assertEquals(error, null);
  assertEquals(data, { birth_date: '1990-01-01' });
});

Deno.test('maybeSingle on no match returns null data and no error', async () => {
  const db = new FakeDb();
  db.tables.profiles = [];
  const { data, error } = await db.from('profiles').select('*').eq('id', 'nope').maybeSingle();
  assertEquals(data, null);
  assertEquals(error, null);
});

Deno.test('insert returns the inserted row with a generated id', async () => {
  const db = new FakeDb();
  db.tables.jobs = [];
  const { data, error } = await db
    .from('jobs')
    .insert({ generation_id: 'g1', user_id: TEST_USER, provider: 'fal' })
    .select('id')
    .single();
  assertEquals(error, null);
  assertEquals(typeof (data as { id: string }).id, 'string');
  assertEquals(db.tables.jobs.length, 1);
});

Deno.test('insert of a duplicate primary key returns a 23505 error', async () => {
  const db = new FakeDb();
  db.primaryKeys.webhook_events = 'id';
  db.tables.webhook_events = [{ id: 'evt_1', type: 'x' }];
  const { error } = await db.from('webhook_events').insert({ id: 'evt_1', type: 'x' });
  assertEquals(error?.code, '23505');
});

Deno.test('update applies only to filtered rows and reports them', async () => {
  const db = new FakeDb();
  db.tables.generations = [
    { id: 'a', status: 'pending' },
    { id: 'b', status: 'pending' },
  ];
  const { data } = await db
    .from('generations')
    .update({ status: 'done' })
    .eq('id', 'a')
    .eq('status', 'pending')
    .select('id');
  assertEquals(data, [{ id: 'a' }]);
  assertEquals(db.tables.generations[1].status, 'pending');
});

Deno.test('delete removes and returns the row', async () => {
  const db = new FakeDb();
  db.tables.generations = [{ id: 'a', user_id: TEST_USER, media_path: 'p.png' }];
  const { data } = await db
    .from('generations')
    .delete()
    .eq('id', 'a')
    .eq('user_id', TEST_USER)
    .select('id,media_path')
    .maybeSingle();
  assertEquals(data, { id: 'a', media_path: 'p.png' });
  assertEquals(db.tables.generations.length, 0);
});

Deno.test('head count returns a count and no rows', async () => {
  const db = new FakeDb();
  db.tables.generations = [
    { id: 'a', user_id: TEST_USER, kind: 'video', status: 'pending' },
    { id: 'b', user_id: TEST_USER, kind: 'video', status: 'pending' },
  ];
  const { count, data } = await db
    .from('generations')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', TEST_USER)
    .eq('status', 'pending');
  assertEquals(count, 2);
  assertEquals(data, null);
});

Deno.test('order desc then limit', async () => {
  const db = new FakeDb();
  db.tables.generations = [
    { id: 'old', created_at: '2026-01-01T00:00:00Z' },
    { id: 'new', created_at: '2026-02-01T00:00:00Z' },
  ];
  const { data } = await db
    .from('generations')
    .select('id')
    .order('created_at', { ascending: false })
    .limit(1);
  assertEquals(data, [{ id: 'new' }]);
});

Deno.test('failNext injects one error then clears', async () => {
  const db = new FakeDb();
  db.tables.generations = [{ id: 'a', status: 'pending' }];
  db.failNext('generations.update', 'connection lost');
  const first = await db.from('generations').update({ status: 'done' }).eq('id', 'a');
  assertEquals(first.error?.message, 'connection lost');
  assertEquals(db.tables.generations[0].status, 'pending');
  const second = await db.from('generations').update({ status: 'done' }).eq('id', 'a');
  assertEquals(second.error, null);
  assertEquals(db.tables.generations[0].status, 'done');
});

Deno.test('rpc records the call and runs the handler', async () => {
  const db = new FakeDb();
  db.rpcHandlers.fn_balances = () => [{ plan_credits: 100, pack_credits: 5 }];
  const { data, error } = await db.rpc('fn_balances', { p_user: TEST_USER });
  assertEquals(error, null);
  assertEquals(data, [{ plan_credits: 100, pack_credits: 5 }]);
  assertEquals(db.rpcCalls[0].name, 'fn_balances');
});

Deno.test('storage upload then signed url round-trips', async () => {
  const storage = new FakeStorage();
  const up = await storage.from('uploads').upload('u/1.png', new Uint8Array([1]), { contentType: 'image/png' });
  assertEquals(up.error, null);
  const { data } = await storage.from('uploads').createSignedUrl('u/1.png', 600);
  assertEquals(data?.signedUrl, 'https://fake.storage/uploads/u/1.png?token=signed');
});

Deno.test('storage failNext makes the next upload fail and store nothing', async () => {
  const storage = new FakeStorage();
  storage.failNext('uploads.upload', 'disk full');
  const { error } = await storage.from('uploads').upload('u/1.png', new Uint8Array([1]), { contentType: 'image/png' });
  assertEquals(error?.message, 'disk full');
  assertEquals(storage.objects.size, 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all api/testing/fakes_test.ts
```

Expected: FAIL — `Module not found "file:///.../api/testing/fakes.ts"`.

- [ ] **Step 3: Write `supabase/functions/api/testing/fakes.ts`**

```ts
// In-memory stand-ins for the service-role Supabase client, Storage, provider
// adapters and moderation. Only the surface the gateway actually uses — this is
// a test double, not a Postgres emulator. Filters are applied in insertion
// order; ordering is a plain string/number compare, which is enough for the
// ISO timestamps and uuids the gateway sorts on.

export type Row = Record<string, unknown>;
export interface FakeError { message: string; code?: string }
export interface FakeResult<T> { data: T; error: FakeError | null; count?: number | null }

export const TEST_USER = '11111111-1111-4111-8111-111111111111';
export const OTHER_USER = '22222222-2222-4222-8222-222222222222';

type Op = 'select' | 'insert' | 'update' | 'delete' | 'upsert';

function project(row: Row, cols: string | undefined): Row {
  if (!cols || cols.trim() === '*') return { ...row };
  const names = cols.split(',').map((c) => c.trim()).filter((c) => c && c !== '*');
  if (names.length === 0) return { ...row };
  const out: Row = {};
  for (const name of names) out[name] = row[name];
  return out;
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a ?? '').localeCompare(String(b ?? ''));
}

class FakeQuery implements PromiseLike<FakeResult<unknown>> {
  private filters: ((r: Row) => boolean)[] = [];
  private cols?: string;
  private sort?: { col: string; asc: boolean };
  private max?: number;
  private headOnly = false;
  private wantCount = false;
  private returning = false;

  constructor(
    private db: FakeDb,
    private table: string,
    private op: Op,
    private payload?: Row | Row[],
    private onConflict?: string,
  ) {}

  select(cols?: string, opts?: { count?: 'exact'; head?: boolean }): this {
    this.returning = true;
    this.cols = cols;
    if (opts?.count) this.wantCount = true;
    if (opts?.head) this.headOnly = true;
    return this;
  }

  eq(col: string, val: unknown): this {
    this.filters.push((r) => r[col] === val);
    return this;
  }

  neq(col: string, val: unknown): this {
    this.filters.push((r) => r[col] !== val);
    return this;
  }

  in(col: string, vals: unknown[]): this {
    this.filters.push((r) => vals.includes(r[col]));
    return this;
  }

  is(col: string, val: unknown): this {
    this.filters.push((r) => (r[col] ?? null) === val);
    return this;
  }

  gte(col: string, val: unknown): this {
    this.filters.push((r) => compare(r[col], val) >= 0);
    return this;
  }

  lt(col: string, val: unknown): this {
    this.filters.push((r) => compare(r[col], val) < 0);
    return this;
  }

  order(col: string, opts?: { ascending?: boolean }): this {
    this.sort = { col, asc: opts?.ascending !== false };
    return this;
  }

  limit(n: number): this {
    this.max = n;
    return this;
  }

  async single(): Promise<FakeResult<Row | null>> {
    const res = await this.run();
    if (res.error) return { data: null, error: res.error };
    const rows = (res.data ?? []) as Row[];
    if (rows.length !== 1) {
      return { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' } };
    }
    return { data: rows[0], error: null };
  }

  async maybeSingle(): Promise<FakeResult<Row | null>> {
    const res = await this.run();
    if (res.error) return { data: null, error: res.error };
    const rows = (res.data ?? []) as Row[];
    if (rows.length > 1) {
      return { data: null, error: { message: 'multiple rows returned', code: 'PGRST116' } };
    }
    return { data: rows[0] ?? null, error: null };
  }

  then<R1 = FakeResult<unknown>, R2 = never>(
    onfulfilled?: ((v: FakeResult<unknown>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.run().then(onfulfilled, onrejected);
  }

  private rows(): Row[] {
    this.db.tables[this.table] ??= [];
    return this.db.tables[this.table];
  }

  private matched(): Row[] {
    return this.rows().filter((r) => this.filters.every((f) => f(r)));
  }

  private run(): Promise<FakeResult<unknown>> {
    const injected = this.db.takeFailure(`${this.table}.${this.op}`);
    if (injected) return Promise.resolve({ data: null, error: injected, count: null });
    if (this.op === 'select') return Promise.resolve(this.runSelect());
    if (this.op === 'insert') return Promise.resolve(this.runInsert());
    if (this.op === 'upsert') return Promise.resolve(this.runUpsert());
    if (this.op === 'update') return Promise.resolve(this.runUpdate());
    return Promise.resolve(this.runDelete());
  }

  private runSelect(): FakeResult<unknown> {
    let out = this.matched();
    if (this.sort) {
      const { col, asc } = this.sort;
      out = [...out].sort((a, b) => (asc ? compare(a[col], b[col]) : compare(b[col], a[col])));
    }
    const count = out.length;
    if (this.max != null) out = out.slice(0, this.max);
    if (this.headOnly) return { data: null, error: null, count };
    return { data: out.map((r) => project(r, this.cols)), error: null, count: this.wantCount ? count : null };
  }

  private runInsert(): FakeResult<unknown> {
    const incoming = Array.isArray(this.payload) ? this.payload : [this.payload as Row];
    const pk = this.db.primaryKeys[this.table];
    const written: Row[] = [];
    for (const item of incoming) {
      if (pk && this.rows().some((r) => r[pk] === item[pk])) {
        return { data: null, error: { message: `duplicate key value violates unique constraint "${this.table}_pkey"`, code: '23505' } };
      }
      const row: Row = {
        id: crypto.randomUUID(),
        created_at: this.db.now().toISOString(),
        ...item,
      };
      this.rows().push(row);
      written.push(row);
    }
    if (!this.returning) return { data: null, error: null };
    return { data: written.map((r) => project(r, this.cols)), error: null };
  }

  private runUpsert(): FakeResult<unknown> {
    const incoming = Array.isArray(this.payload) ? this.payload : [this.payload as Row];
    const keys = (this.onConflict ?? 'id').split(',').map((k) => k.trim());
    for (const item of incoming) {
      const hit = this.rows().find((r) => keys.every((k) => r[k] === item[k]));
      if (hit) Object.assign(hit, item);
      if (!hit) this.rows().push({ id: crypto.randomUUID(), created_at: this.db.now().toISOString(), ...item });
    }
    if (!this.returning) return { data: null, error: null };
    return { data: incoming.map((r) => project(r, this.cols)), error: null };
  }

  private runUpdate(): FakeResult<unknown> {
    const hits = this.matched();
    for (const row of hits) Object.assign(row, this.payload as Row);
    if (!this.returning) return { data: null, error: null };
    return { data: hits.map((r) => project(r, this.cols)), error: null };
  }

  private runDelete(): FakeResult<unknown> {
    const hits = this.matched();
    this.db.tables[this.table] = this.rows().filter((r) => !hits.includes(r));
    if (!this.returning) return { data: null, error: null };
    return { data: hits.map((r) => project(r, this.cols)), error: null };
  }
}

export interface StoredObject { bytes: Uint8Array; contentType: string }

export class FakeStorage {
  readonly objects = new Map<string, StoredObject>();
  private failures = new Map<string, FakeError>();

  failNext(key: string, message: string): void {
    this.failures.set(key, { message });
  }

  private takeFailure(key: string): FakeError | null {
    const hit = this.failures.get(key);
    if (!hit) return null;
    this.failures.delete(key);
    return hit;
  }

  from(bucket: string) {
    const objects = this.objects;
    const take = (op: string) => this.takeFailure(`${bucket}.${op}`);
    return {
      // deno-lint-ignore no-explicit-any
      async upload(path: string, bytes: Uint8Array, opts?: any) {
        const fail = take('upload');
        if (fail) return { data: null, error: fail };
        objects.set(`${bucket}/${path}`, { bytes, contentType: opts?.contentType ?? 'application/octet-stream' });
        return { data: { path }, error: null };
      },
      async createSignedUrl(path: string, _ttl: number) {
        const fail = take('createSignedUrl');
        if (fail) return { data: null, error: fail };
        if (!objects.has(`${bucket}/${path}`)) return { data: null, error: { message: 'Object not found' } };
        return { data: { signedUrl: `https://fake.storage/${bucket}/${path}?token=signed` }, error: null };
      },
      async copy(from: string, to: string) {
        const fail = take('copy');
        if (fail) return { data: null, error: fail };
        const hit = objects.get(`${bucket}/${from}`);
        if (!hit) return { data: null, error: { message: 'Object not found' } };
        objects.set(`${bucket}/${to}`, hit);
        return { data: { path: to }, error: null };
      },
      async remove(paths: string[]) {
        const fail = take('remove');
        if (fail) return { data: null, error: fail };
        for (const p of paths) objects.delete(`${bucket}/${p}`);
        return { data: null, error: null };
      },
      async download(path: string) {
        const fail = take('download');
        if (fail) return { data: null, error: fail };
        const hit = objects.get(`${bucket}/${path}`);
        if (!hit) return { data: null, error: { message: 'Object not found' } };
        return { data: new Blob([hit.bytes as BlobPart], { type: hit.contentType }), error: null };
      },
    };
  }
}

export class FakeDb {
  readonly tables: Record<string, Row[]> = {};
  readonly primaryKeys: Record<string, string> = {};
  readonly rpcCalls: { name: string; args: Row }[] = [];
  rpcHandlers: Record<string, (args: Row, db: FakeDb) => unknown> = {};
  readonly storage = new FakeStorage();
  private failures = new Map<string, FakeError>();
  private clock = new Date('2026-09-20T00:00:00.000Z');

  now(): Date {
    return this.clock;
  }

  setNow(d: Date): void {
    this.clock = d;
  }

  failNext(key: string, message: string, code?: string): void {
    this.failures.set(key, { message, code });
  }

  takeFailure(key: string): FakeError | null {
    const hit = this.failures.get(key);
    if (!hit) return null;
    this.failures.delete(key);
    return hit;
  }

  from(table: string) {
    return {
      select: (cols?: string, opts?: { count?: 'exact'; head?: boolean }) =>
        new FakeQuery(this, table, 'select').select(cols, opts),
      insert: (payload: Row | Row[]) => new FakeQuery(this, table, 'insert', payload),
      upsert: (payload: Row | Row[], opts?: { onConflict?: string }) =>
        new FakeQuery(this, table, 'upsert', payload, opts?.onConflict),
      update: (payload: Row) => new FakeQuery(this, table, 'update', payload),
      delete: () => new FakeQuery(this, table, 'delete'),
    };
  }

  async rpc(name: string, args: Row): Promise<FakeResult<unknown>> {
    this.rpcCalls.push({ name, args });
    const injected = this.takeFailure(`rpc.${name}`);
    if (injected) return { data: null, error: injected };
    const handler = this.rpcHandlers[name];
    if (!handler) return { data: null, error: null };
    try {
      return { data: handler(args, this) as unknown, error: null };
    } catch (e) {
      return { data: null, error: { message: e instanceof Error ? e.message : String(e) } };
    }
  }

  auth = {
    getUser: (token: string) => {
      const user = this.tokens.get(token);
      if (!user) return Promise.resolve({ data: { user: null }, error: { message: 'invalid token' } });
      return Promise.resolve({ data: { user }, error: null });
    },
    admin: {
      deleteUser: (id: string) => {
        this.deletedUsers.push(id);
        return Promise.resolve({ data: null, error: null });
      },
    },
  };

  readonly tokens = new Map<string, { id: string; email: string }>();
  readonly deletedUsers: string[] = [];
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all api/testing/fakes_test.ts
```

Expected: `ok | 12 passed | 0 failed`.

- [ ] **Step 5: Run the whole edge suite**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all _shared api
```

Expected: `52 passed | 0 failed` (40 existing + 12 new). User commits.

---

## Task 2: Extract `createApp(deps)` from `api/index.ts`

**Files:**
- Create: `supabase/functions/api/app.ts`
- Create: `supabase/functions/api/app_test.ts`
- Modify: `supabase/functions/api/index.ts` (becomes composition only)
- Modify: `supabase/functions/api/testing/fakes.ts` (type `testDeps()` as `ApiDeps`, add the adapter/moderation fakes)

**Interfaces:**
- Consumes: `FakeDb`, `FakeStorage`, `TEST_USER`, `OTHER_USER` from Task 1.
- Produces:
  ```ts
  export interface ApiEnv {
    appOrigins: string[];
    planPriceIds: Record<string, string | undefined>;
    launchCouponId: string | undefined;
  }
  export interface ApiDeps {
    admin: SupabaseClient;
    stripe: Stripe;
    moderate: (input: { text?: string; imageUrl?: string }) => Promise<ModerationResult>;
    adapterFor: (familyId: string) => ProviderAdapter;
    storageFor: (backend: StorageBackend) => StorageAdapter;
    appleVerifier: () => { verifyAndDecodeTransaction(jws: string): Promise<Record<string, unknown>> };
    fcmAccount: ServiceAccount | null;
    now: () => Date;
  }
  export function createApp(deps: ApiDeps): Hono<Vars>;
  ```
  `ModerationResult` is still `{flagged, categories}` at this point; Task 4 changes it.

**Why this is safe:** every moved route body references `admin`, `stripe`, `moderate`, `adapterFor`, `storageFor` and `fcmAccount` as free identifiers. Destructuring those exact names at the top of `createApp` means **no edit is required inside any route body** — the move is cut, paste, and one destructure line.

- [ ] **Step 1: Write the failing characterization test**

Create `supabase/functions/api/app_test.ts`:

```ts
import { assertEquals } from 'jsr:@std/assert';
import { createApp } from './app.ts';
import { OTHER_USER, TEST_USER, testDeps } from './testing/fakes.ts';

const AUTH = { authorization: 'Bearer test-token' };

Deno.test('no token → 401', async () => {
  const app = createApp(testDeps());
  const res = await app.request('/api/profile');
  assertEquals(res.status, 401);
  assertEquals((await res.json()).error.code, 'unauthorized');
});

Deno.test('unknown token → 401', async () => {
  const app = createApp(testDeps());
  const res = await app.request('/api/profile', { headers: { authorization: 'Bearer nope' } });
  assertEquals(res.status, 401);
});

Deno.test('age-unconfirmed user → 403 on a protected route', async () => {
  const deps = testDeps();
  const db = deps.admin as unknown as import('./testing/fakes.ts').FakeDb;
  db.tables.profiles = [{ id: TEST_USER, birth_date: null, strikes: 0 }];
  const app = createApp(deps);
  const res = await app.request('/api/generations', { headers: AUTH });
  assertEquals(res.status, 403);
  assertEquals((await res.json()).error.code, 'age_unconfirmed');
});

Deno.test('age-unconfirmed user can still read their profile', async () => {
  const deps = testDeps();
  const db = deps.admin as unknown as import('./testing/fakes.ts').FakeDb;
  db.tables.profiles = [{ id: TEST_USER, birth_date: null, strikes: 0, prefs: {} }];
  const app = createApp(deps);
  const res = await app.request('/api/profile', { headers: AUTH });
  assertEquals(res.status, 200);
  assertEquals((await res.json()).profile.ageConfirmed, false);
});

Deno.test('malformed JSON → readable 400', async () => {
  const app = createApp(testDeps());
  const res = await app.request('/api/generations', {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: '{not json',
  });
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error.code, 'invalid_payload');
});

Deno.test('another user\'s generation is invisible', async () => {
  const deps = testDeps();
  const db = deps.admin as unknown as import('./testing/fakes.ts').FakeDb;
  db.tables.generations = [
    { id: 'g-other', user_id: OTHER_USER, kind: 'image', status: 'done', media_path: 'x.png', settings: {}, price_credits: 10 },
  ];
  const app = createApp(deps);
  const res = await app.request('/api/generations', { headers: AUTH });
  assertEquals(res.status, 200);
  assertEquals((await res.json()).items, []);
});

Deno.test('deleting another user\'s generation → 404', async () => {
  const deps = testDeps();
  const db = deps.admin as unknown as import('./testing/fakes.ts').FakeDb;
  db.tables.generations = [{ id: 'g-other', user_id: OTHER_USER, media_path: 'x.png' }];
  const app = createApp(deps);
  const res = await app.request('/api/generations/g-other', { method: 'DELETE', headers: AUTH });
  assertEquals(res.status, 404);
  assertEquals(db.tables.generations.length, 1);
});

Deno.test('POST /errors answers 204 with no body', async () => {
  const app = createApp(testDeps());
  const res = await app.request('/api/errors', {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'boom' }),
  });
  assertEquals(res.status, 204);
  assertEquals(await res.text(), '');
});

Deno.test('health needs no token', async () => {
  const deps = testDeps();
  const db = deps.admin as unknown as import('./testing/fakes.ts').FakeDb;
  db.tables.models = [{ id: 'flux', enabled: true }];
  const app = createApp(deps);
  const res = await app.request('/api/health');
  assertEquals(res.status, 200);
  assertEquals((await res.json()).ok, true);
});

Deno.test('unhandled route error answers 500 with a request id', async () => {
  const deps = testDeps();
  const db = deps.admin as unknown as import('./testing/fakes.ts').FakeDb;
  db.rpcHandlers.fn_balances = () => {
    throw new Error('db down');
  };
  const app = createApp(deps);
  const res = await app.request('/api/profile', { headers: AUTH });
  assertEquals(res.status, 500);
  const body = await res.json();
  assertEquals(body.error.code, 'internal');
  assertEquals(typeof body.error.requestId, 'string');
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all api/app_test.ts
```

Expected: FAIL — `Module not found "file:///.../api/app.ts"`.

- [ ] **Step 3: Create `api/app.ts` with the deps interface and the moved bodies**

Perform this move mechanically:

1. `git mv` is not used — create `app.ts` and cut from `index.ts`.
2. Copy **all** of `index.ts` into `app.ts`.
3. In `app.ts`, delete these module-scope statements (they are production wiring and move to `index.ts`): the `admin = createClient(...)` block (current L52–55), the `stripe = new Stripe(...)` block (L57–60), `PLAN_PRICE_IDS` (L61–64), `LAUNCH_COUPON_ID` (L65), `APP_ORIGINS` (L69–72), `const fcmAccount = parseServiceAccount(...)` (L48), and the final `Deno.serve(app.fetch);` (L2059).
4. Keep at module scope in `app.ts` (they are pure): `SUSPEND_STRIKES`, `UPLOAD_MAX_BYTES`, `DEV_ORIGIN`, `sniffImage`, `MAX_PROMPT_LEN`, `AR_PATTERN`, `VIDEO_MODES`, `REF_SIGN_TTL_S`, `UPLOAD_PATH`, `sanitizeSettings`, `PREF_CHECKS`, `sanitizePrefs`, `type Vars`, `fail`, `type ErrCtx`, `KNOWN_CLIENTS`, `clientOf`, `sanitizeLabel`, `AGE_EXEMPT`, `SIGN_TTL_S`, `RESIGN_FLOOR_MS`, `type JobRow`, `NOT_CANCELLABLE`, `jobDto`, `toLedgerDto`, `parseBirthDate`, `ageFromBirthDate`, `MAX_STORE_ATTEMPTS`, `THUMB_MAX_BYTES`.
5. Wrap **everything else** — from `const app = new Hono<Vars>().basePath('/api');` down to the last route — inside `createApp`. That includes `allowedOrigin`, `appOrigin`, `checkoutReturnUrls`, `logError`, the memos (`ageOkMemo`, `signedUrlMemo`, `r2SignMemo`), `signMedia`, `signStored`, `toGenerationDto(s)`, `isSuspended`, `modelGate`, `recordStrike`, `notifySettled`, `pushToDevices`, `finishJob`, `dropLostObject`, `storeVideoResult`, `creditsOf`, `stripeCustomerFor`, `activePlan`, `resolveParentVideo`, `prepareVideo`, `resolveVideoPrep`, and every `app.get/post/patch/put/delete` and `app.use`.
6. Change the value imports that are now injected into type-only imports, and leave the rest untouched.

The result — header and footer shown in full, route bodies unchanged:

```ts
// Vansen API gateway. All data access flows through here (tables are RLS
// deny-all; RPCs are service_role-only). Client's only other Supabase surface
// is Auth. REST contract doubles as the future Java migration contract.
//
// createApp(deps) exists so routes can be exercised with app.request(...) and
// in-memory fakes. index.ts builds the production deps and serves this app.
import { Hono, type Context } from 'jsr:@hono/hono';
import { cors } from 'jsr:@hono/hono/cors';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import type Stripe from 'npm:stripe@17';
import {
  CREDIT_PACKS,
  PERSONA_GEN,
  PERSONA_SLOTS,
  PERSONA_TRAINING,
  STUDIO_MARGIN,
  UPSCALER,
  creditCost,
  editToolById,
  familyById,
  packCredits,
  personaGenCreditCost,
  upscaleCreditCost,
  videoFamilySupports,
  type GenerationSettings,
  type ModelFamily,
  type VideoMode,
} from './_shared/model-families.ts';
import { applyStyle, styleById } from './_shared/style-presets.ts';
import { GenerationOp, LedgerType, MediaKind } from './_shared/enums.ts';
import type { ProviderAdapter } from './_shared/providers/types.ts';
import {
  PERSONA_TRIGGER,
  checkPersonaTraining,
  submitPersonaTraining,
} from './_shared/providers/fal.ts';
import { zipSync } from 'npm:fflate@0.8.2';
import type { CheckResult } from './_shared/providers/types.ts';
import { videoPath, thumbPath, type StorageAdapter, type StorageBackend } from './_shared/storage/index.ts';
import { dailyCapState, expectedSecondsFor, referenceRule, videoJobCapReached } from './_shared/video-rules.ts';
import { isUrlResult, type SubmitResult } from './_shared/providers/types.ts';
import type { ModerationResult } from './_shared/moderation.ts';
import { safetyId } from './_shared/safety.ts';
import { sendGenerationPush, type PushEvent, type ServiceAccount } from './_shared/push.ts';
import { laneFor } from './_shared/billing-lanes.ts';
import { applyIapTransaction } from './_shared/iap-grants.ts';

export interface ApiEnv {
  appOrigins: string[];
  planPriceIds: Record<string, string | undefined>;
  launchCouponId: string | undefined;
}

export interface ApiDeps {
  admin: SupabaseClient;
  stripe: Stripe;
  moderate: (input: { text?: string; imageUrl?: string }) => Promise<ModerationResult>;
  adapterFor: (familyId: string) => ProviderAdapter;
  storageFor: (backend: StorageBackend) => StorageAdapter;
  appleVerifier: () => { verifyAndDecodeTransaction(jws: string): Promise<Record<string, unknown>> };
  fcmAccount: ServiceAccount | null;
  env: ApiEnv;
  now: () => Date;
}

const SUSPEND_STRIKES = 2;
const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

// ... every other pure module-scope const/function from step 4, unchanged ...

export function createApp(deps: ApiDeps): Hono<Vars> {
  // These names deliberately match the identifiers the moved route bodies
  // already use, so the bodies needed no edits when they moved here.
  const { admin, stripe, moderate, adapterFor, storageFor, appleVerifier, fcmAccount } = deps;
  const APP_ORIGINS = deps.env.appOrigins;
  const PLAN_PRICE_IDS = deps.env.planPriceIds;
  const LAUNCH_COUPON_ID = deps.env.launchCouponId;

  /** The single source of truth for "is this origin ours?" — used for both CORS
   * and the Stripe return URL. Only ever returns an origin we recognise. */
  function allowedOrigin(origin: string | undefined): string | null {
    if (!origin) return null;
    if (DEV_ORIGIN.test(origin)) return origin;
    return APP_ORIGINS.includes(origin) ? origin : null;
  }

  // ... appOrigin, checkoutReturnUrls, the Hono app, every middleware,
  //     every helper and every route — all moved verbatim ...

  return app;
}
```

- [ ] **Step 4: Rewrite `api/index.ts` as composition only**

Replace the entire file with:

```ts
// Production composition for the Vansen API gateway. All behaviour lives in
// app.ts; this file only wires real clients, secrets and the listener so the
// routes stay testable with in-memory fakes.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import Stripe from 'npm:stripe@17';
import { createApp } from './app.ts';
import { adapterFor } from './_shared/providers/index.ts';
import { storageFor } from './_shared/storage/index.ts';
import { moderate } from './_shared/moderation.ts';
import { parseServiceAccount } from './_shared/push.ts';
import { appleVerifier } from './_shared/apple-verifier.ts';

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2024-06-20' as Stripe.LatestApiVersion,
  httpClient: Stripe.createFetchHttpClient(),
});

/** Deployed origins, comma-separated (e.g. "https://vansen.app"). Dev servers
 * are matched by pattern inside app.ts — `ng serve` picks whatever port is free. */
const appOrigins = (Deno.env.get('APP_ORIGIN') ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const app = createApp({
  admin,
  stripe,
  moderate,
  adapterFor,
  storageFor,
  appleVerifier,
  fcmAccount: parseServiceAccount(Deno.env.get('FCM_SERVICE_ACCOUNT')),
  env: {
    appOrigins,
    planPriceIds: {
      studio: Deno.env.get('STRIPE_STUDIO_PRICE_ID'),
      pro: Deno.env.get('STRIPE_PRO_PRICE_ID'),
    },
    launchCouponId: Deno.env.get('STRIPE_LAUNCH_COUPON_ID'), // $5 off, 2 months
  },
  now: () => new Date(),
});

Deno.serve(app.fetch);
```

- [ ] **Step 5: Add `testDeps()` and the remaining fakes to `api/testing/fakes.ts`**

Append to `fakes.ts`:

```ts
import type { ApiDeps } from '../app.ts';
import type { CheckResult, ProviderAdapter, SubmitCtx } from '../_shared/providers/types.ts';

export interface FakeAdapter {
  adapter: ProviderAdapter;
  submits: SubmitCtx[];
  checks: string[];
  cancels: string[];
}

/** Records every call; answers with whatever the test queues up. */
export function fakeAdapter(opts?: {
  submit?: (ctx: SubmitCtx) => Promise<{ providerRef: string; inline?: CheckResult }>;
  check?: CheckResult;
}): FakeAdapter {
  const submits: SubmitCtx[] = [];
  const checks: string[] = [];
  const cancels: string[] = [];
  const adapter: ProviderAdapter = {
    provider: 'fal',
    async submit(ctx) {
      submits.push(ctx);
      if (opts?.submit) return await opts.submit(ctx);
      return { providerRef: 'fake-ref' };
    },
    async check(ref) {
      checks.push(ref);
      return opts?.check ?? { state: 'running' };
    },
    async cancel(ref) {
      cancels.push(ref);
    },
  };
  return { adapter, submits, checks, cancels };
}

export interface FakeModeration {
  moderate: ApiDeps['moderate'];
  calls: { text?: string; imageUrl?: string }[];
  next(result: { flagged: boolean; categories?: Record<string, number> }): void;
}

export function fakeModeration(): FakeModeration {
  const calls: { text?: string; imageUrl?: string }[] = [];
  let queued: { flagged: boolean; categories?: Record<string, number> } | null = null;
  return {
    calls,
    next(result) {
      queued = result;
    },
    moderate: (input) => {
      calls.push(input);
      const result = queued ?? { flagged: false };
      queued = null;
      return Promise.resolve({ flagged: result.flagged, categories: result.categories ?? {} });
    },
  };
}

/** A gateway wired to fakes, with TEST_USER signed in and past the age gate. */
export function testDeps(over: Partial<ApiDeps> = {}): ApiDeps {
  const db = new FakeDb();
  db.primaryKeys.webhook_events = 'id';
  db.tokens.set('test-token', { id: TEST_USER, email: 'test@example.com' });
  db.tables.profiles = [{ id: TEST_USER, birth_date: '1990-01-01', strikes: 0, prefs: {} }];
  db.tables.generations = [];
  db.tables.jobs = [];
  db.tables.models = [];
  db.tables.subscriptions = [];
  db.tables.ledger_entries = [];
  db.rpcHandlers.fn_balances = () => [{ plan_credits: 10_000, pack_credits: 0 }];
  const provider = fakeAdapter();
  const moderation = fakeModeration();
  return {
    admin: db as unknown as ApiDeps['admin'],
    stripe: {} as ApiDeps['stripe'],
    moderate: moderation.moderate,
    adapterFor: () => provider.adapter,
    storageFor: () => ({
      put: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      signedUrl: () => Promise.resolve('https://fake.r2/object'),
    }) as unknown as ReturnType<ApiDeps['storageFor']>,
    appleVerifier: () => ({ verifyAndDecodeTransaction: () => Promise.resolve({}) }),
    fcmAccount: null,
    env: { appOrigins: ['https://vansen.app'], planPriceIds: {}, launchCouponId: undefined },
    now: () => db.now(),
    ...over,
  };
}
```

- [ ] **Step 6: Run the characterization tests**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all api
```

Expected: `22 passed | 0 failed` (12 fakes + 10 characterization).

Note: the `POST /errors` 204 test and the `unhandled → 500` test both pass **before** any behaviour change; they exist to prove the extraction preserved behaviour.

- [ ] **Step 7: Type-check every entrypoint and run the full edge suite**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno check api/index.ts api/app.ts stripe-webhook/index.ts appstore-webhook/index.ts && deno test --allow-all _shared api
```

Expected: `Check` lines with no errors, then `62 passed | 0 failed`. User commits.

---

## Task 3: Client handles an empty successful response

**Files:**
- Modify: `src/app/core/api/api-service.ts:118`
- Test: `src/app/core/api/api-service.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ApiService.post()` resolves to `undefined` for a 204 instead of rejecting.

- [ ] **Step 1: Write the failing test**

Append to `src/app/core/api/api-service.spec.ts` (inside the existing top-level `describe`):

```ts
it('accepts a successful empty response', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
  await expect(TestBed.inject(ApiService).post('/errors', { message: 'test' })).resolves.toBeUndefined();
});
```

If the file has no `TestBed.configureTestingModule` in a `beforeEach`, copy the arrangement used by the file's existing tests verbatim rather than inventing one.

- [ ] **Step 2: Run to verify it fails**

```bash
cd /Users/user/IdeaProjects/vansen && npm test -- --watch=false
```

Expected: FAIL — the new test rejects with a `SyntaxError` from `response.json()` on an empty body.

- [ ] **Step 3: Handle 204 in `handle`**

In `src/app/core/api/api-service.ts`, replace line 118:

```ts
    if (response.ok) return (await response.json()) as T;
```

with:

```ts
    // 204 (POST /errors) and any other empty success: there is no JSON to parse.
    if (response.status === 204 || response.headers.get('content-length') === '0') {
      return undefined as T;
    }
    if (response.ok) return (await response.json()) as T;
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd /Users/user/IdeaProjects/vansen && npm test -- --watch=false
```

Expected: `240 passed`, 42 files. User commits.

---

## Task 4: Moderation becomes a three-state decision that fails closed

**Files:**
- Modify: `supabase/functions/_shared/moderation.ts`
- Create: `supabase/functions/_shared/moderation_test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export type ModerationDecision =
    | { state: 'allowed' }
    | { state: 'blocked'; categories: Record<string, number> }
    | { state: 'unavailable'; reason: string; retryAfterSeconds: number };
  export async function moderate(input: { text?: string; imageUrl?: string }): Promise<ModerationDecision>;
  export type ModerationResult = ModerationDecision; // kept so app.ts's ApiDeps type keeps compiling
  ```
  Callers switch on `state`. `{ state: 'allowed' }` for genuinely empty input (no text and no image) is intentional — there is nothing to moderate — but Task 5 makes it impossible for a required image check to reach that branch with an undefined URL.

- [ ] **Step 0: Upgrade the shared moderation fake in this task**

Task 2 characterizes the old `flagged` API. Replace its `FakeModeration` and implementation in `api/testing/fakes.ts` when introducing the three-state contract. Task 5 imports this replacement:

```ts
import type { ModerationDecision } from '../_shared/moderation.ts';
export interface FakeModeration {
  moderate: ApiDeps['moderate'];
  calls: { text?: string; imageUrl?: string }[];
  next(result: ModerationDecision): void;
}
export function fakeModeration(): FakeModeration {
  const calls: { text?: string; imageUrl?: string }[] = [];
  let queued: ModerationDecision | null = null;
  return {
    calls,
    next(result) { queued = result; },
    moderate(input) {
      calls.push(input);
      const result = queued ?? { state: 'allowed' as const };
      queued = null;
      return Promise.resolve(result);
    },
  };
}
```

- [ ] **Step 1: Write the failing test**

Create `supabase/functions/_shared/moderation_test.ts`:

```ts
import { assertEquals } from 'jsr:@std/assert';
import { moderate } from './moderation.ts';

const realFetch = globalThis.fetch;
const realKey = Deno.env.get('OPENAI_API_KEY');

function restore() {
  globalThis.fetch = realFetch;
  if (realKey === undefined) Deno.env.delete('OPENAI_API_KEY');
  if (realKey !== undefined) Deno.env.set('OPENAI_API_KEY', realKey);
}

Deno.test('missing key is unavailable, never allowed', async () => {
  Deno.env.delete('OPENAI_API_KEY');
  const decision = await moderate({ text: 'hello' });
  assertEquals(decision.state, 'unavailable');
  restore();
});

Deno.test('non-OK http is unavailable', async () => {
  Deno.env.set('OPENAI_API_KEY', 'test-key');
  globalThis.fetch = () => Promise.resolve(new Response('', { status: 503 }));
  const decision = await moderate({ text: 'hello' });
  assertEquals(decision.state, 'unavailable');
  restore();
});

Deno.test('429 reports the provider retry-after', async () => {
  Deno.env.set('OPENAI_API_KEY', 'test-key');
  globalThis.fetch = () =>
    Promise.resolve(new Response('', { status: 429, headers: { 'retry-after': '30' } }));
  const decision = await moderate({ text: 'hello' });
  assertEquals(decision, { state: 'unavailable', reason: 'moderation_http_429', retryAfterSeconds: 30 });
  restore();
});

Deno.test('network throw is unavailable', async () => {
  Deno.env.set('OPENAI_API_KEY', 'test-key');
  globalThis.fetch = () => Promise.reject(new Error('econnreset'));
  const decision = await moderate({ text: 'hello' });
  assertEquals(decision.state, 'unavailable');
  restore();
});

Deno.test('malformed body is unavailable, not allowed', async () => {
  Deno.env.set('OPENAI_API_KEY', 'test-key');
  globalThis.fetch = () => Promise.resolve(new Response(JSON.stringify({ nope: true }), { status: 200 }));
  const decision = await moderate({ text: 'hello' });
  assertEquals(decision.state, 'unavailable');
  restore();
});

Deno.test('flagged content is blocked with its categories', async () => {
  Deno.env.set('OPENAI_API_KEY', 'test-key');
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({ results: [{ flagged: true, category_scores: { violence: 0.9 } }] }),
        { status: 200 },
      ),
    );
  const decision = await moderate({ text: 'bad' });
  assertEquals(decision, { state: 'blocked', categories: { violence: 0.9 } });
  restore();
});

Deno.test('clean content is allowed', async () => {
  Deno.env.set('OPENAI_API_KEY', 'test-key');
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({ results: [{ flagged: false, category_scores: {} }] }), { status: 200 }),
    );
  assertEquals(await moderate({ text: 'a cat' }), { state: 'allowed' });
  restore();
});

Deno.test('genuinely empty input is allowed without calling the api', async () => {
  Deno.env.set('OPENAI_API_KEY', 'test-key');
  let called = false;
  globalThis.fetch = () => {
    called = true;
    return Promise.resolve(new Response('{}', { status: 200 }));
  };
  assertEquals(await moderate({}), { state: 'allowed' });
  assertEquals(called, false);
  restore();
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all _shared/moderation_test.ts
```

Expected: FAIL — six of eight assertions report `"allowed"`/`{flagged:false}` where `"unavailable"` is expected.

- [ ] **Step 3: Rewrite `_shared/moderation.ts`**

```ts
// Universal moderation gate — runs on every prompt and every image BEFORE any
// provider sees them, and BEFORE any charge. OpenAI omni-moderation (free,
// multimodal).
//
// This gate fails CLOSED. A missing key, an outage, a timeout or a malformed
// response returns `unavailable`, and callers must refuse the request with a
// 503 — never charge, never dispatch, never record a strike. Failing open would
// make "every image is moderated" untrue exactly when it matters most.

export type ModerationDecision =
  | { state: 'allowed' }
  | { state: 'blocked'; categories: Record<string, number> }
  | { state: 'unavailable'; reason: string; retryAfterSeconds: number };

/** Alias kept so ApiDeps and other callers can name the return type. */
export type ModerationResult = ModerationDecision;

const DEFAULT_RETRY_S = 10;
const TIMEOUT_MS = 10_000;

function retryAfterOf(res: Response): number {
  const header = Number(res.headers.get('retry-after'));
  if (Number.isFinite(header) && header > 0) return Math.min(header, 300);
  return DEFAULT_RETRY_S;
}

export async function moderate(input: { text?: string; imageUrl?: string }): Promise<ModerationDecision> {
  const parts: unknown[] = [];
  if (input.text) parts.push({ type: 'text', text: input.text });
  if (input.imageUrl) parts.push({ type: 'image_url', image_url: { url: input.imageUrl } });
  if (parts.length === 0) return { state: 'allowed' };

  const key = Deno.env.get('OPENAI_API_KEY');
  if (!key) {
    console.error('moderation unavailable: OPENAI_API_KEY missing');
    return { state: 'unavailable', reason: 'moderation_key_missing', retryAfterSeconds: DEFAULT_RETRY_S };
  }

  try {
    const res = await fetch('https://api.openai.com/v1/moderations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'omni-moderation-latest', input: parts }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error('moderation api error', res.status);
      return {
        state: 'unavailable',
        reason: `moderation_http_${res.status}`,
        retryAfterSeconds: retryAfterOf(res),
      };
    }
    const data = await res.json();
    const result = data?.results?.[0];
    if (!result || typeof result.flagged !== 'boolean') {
      console.error('moderation response malformed');
      return { state: 'unavailable', reason: 'moderation_malformed', retryAfterSeconds: DEFAULT_RETRY_S };
    }
    if (!result.flagged) return { state: 'allowed' };
    return { state: 'blocked', categories: result.category_scores ?? {} };
  } catch (e) {
    console.error('moderation request threw', e);
    return { state: 'unavailable', reason: 'moderation_unreachable', retryAfterSeconds: DEFAULT_RETRY_S };
  }
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all _shared/moderation_test.ts
```

Expected: `8 passed | 0 failed`.

- [ ] **Step 5: Expect the gateway to stop compiling — that is the point**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno check api/app.ts
```

Expected: FAIL — `Property 'flagged' does not exist on type 'ModerationDecision'` at each of the five call sites. Task 5 fixes them. Do not patch them here; do not commit a non-compiling tree — Task 4 and Task 5 are committed together at the end of Task 5.

---

## Task 5: Every moderation call site fails closed

**Files:**
- Modify: `supabase/functions/api/app.ts` (five call sites + one new one)
- Test: `supabase/functions/api/moderation_routes_test.ts` (create)

**Interfaces:**
- Consumes: `ModerationDecision` (Task 4), `createApp`/`testDeps` (Tasks 1–2).
- Produces: a shared `moderationFailure(c, decision)` helper in `app.ts` returning the 503/422 response, and `requireModeratedImage(...)` which uploads-then-signs-then-moderates and refuses if any step fails.

**Error copy (verbatim, asserted by tests):**
- 503 `moderation_unavailable` → `Safety check is unavailable right now. Nothing was charged — please try again shortly.`
- 422 `content_policy` (prompt) → `This prompt violates our content policy.` (unchanged)
- 422 `content_policy` (image) → `This image violates our content policy.` (unchanged)

- [ ] **Step 1: Write the failing route tests**

Create `supabase/functions/api/moderation_routes_test.ts`:

```ts
import { assertEquals } from 'jsr:@std/assert';
import { createApp } from './app.ts';
import { FakeDb, TEST_USER, fakeModeration, testDeps } from './testing/fakes.ts';

const AUTH = { authorization: 'Bearer test-token' };

function pngBytes(): Uint8Array {
  // 8-byte PNG signature is all sniffImage needs.
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
}

function uploadForm(): FormData {
  const form = new FormData();
  form.append('file', new Blob([pngBytes() as BlobPart], { type: 'image/png' }), 'a.png');
  return form;
}

function subscribed(db: FakeDb) {
  db.tables.subscriptions = [
    { user_id: TEST_USER, plan: 'pro', status: 'active', current_period_end: '2099-01-01T00:00:00Z' },
  ];
}

Deno.test('upload: moderation unavailable → 503, nothing stored, no strike', async () => {
  const moderation = fakeModeration();
  moderation.next({ state: 'unavailable', reason: 'moderation_http_503', retryAfterSeconds: 30 });
  const deps = testDeps({ moderate: moderation.moderate });
  const db = deps.admin as unknown as FakeDb;
  const app = createApp(deps);

  const res = await app.request('/api/uploads', { method: 'POST', headers: AUTH, body: uploadForm() });

  assertEquals(res.status, 503);
  assertEquals((await res.json()).error.code, 'moderation_unavailable');
  assertEquals(res.headers.get('retry-after'), '30');
  assertEquals(db.storage.objects.size, 0);
  assertEquals(db.tables.moderation_events ?? [], []);
  assertEquals(db.rpcCalls.filter((r) => r.name === 'fn_increment_strike').length, 0);
});

Deno.test('upload: signing failure blocks the upload instead of skipping the check', async () => {
  const moderation = fakeModeration();
  const deps = testDeps({ moderate: moderation.moderate });
  const db = deps.admin as unknown as FakeDb;
  db.storage.failNext('uploads.createSignedUrl', 'signer down');
  const app = createApp(deps);

  const res = await app.request('/api/uploads', { method: 'POST', headers: AUTH, body: uploadForm() });

  assertEquals(res.status, 503);
  assertEquals((await res.json()).error.code, 'moderation_unavailable');
  assertEquals(moderation.calls.length, 0);
  assertEquals(db.storage.objects.size, 0);
});

Deno.test('upload: storage write failure never reaches moderation', async () => {
  const moderation = fakeModeration();
  const deps = testDeps({ moderate: moderation.moderate });
  const db = deps.admin as unknown as FakeDb;
  db.storage.failNext('uploads.upload', 'disk full');
  const app = createApp(deps);

  const res = await app.request('/api/uploads', { method: 'POST', headers: AUTH, body: uploadForm() });

  assertEquals(res.status, 400);
  assertEquals(moderation.calls.length, 0);
});

Deno.test('upload: flagged image is quarantined once and striked once', async () => {
  const moderation = fakeModeration();
  moderation.next({ state: 'blocked', categories: { violence: 0.9 } });
  const deps = testDeps({ moderate: moderation.moderate });
  const db = deps.admin as unknown as FakeDb;
  db.tables.moderation_events = [];
  const app = createApp(deps);

  const res = await app.request('/api/uploads', { method: 'POST', headers: AUTH, body: uploadForm() });

  assertEquals(res.status, 422);
  assertEquals((await res.json()).error.code, 'content_policy');
  assertEquals(db.tables.moderation_events.length, 1);
  const quarantined = [...db.storage.objects.keys()].filter((k) => k.includes('quarantine/'));
  assertEquals(quarantined.length, 1);
  assertEquals(db.rpcCalls.filter((r) => r.name === 'fn_increment_strike').length, 1);
});

Deno.test('upload: quarantine copy failure still refuses and does not record phantom evidence', async () => {
  const moderation = fakeModeration();
  moderation.next({ state: 'blocked', categories: { violence: 0.9 } });
  const deps = testDeps({ moderate: moderation.moderate });
  const db = deps.admin as unknown as FakeDb;
  db.tables.moderation_events = [];
  db.storage.failNext('uploads.copy', 'copy failed');
  const app = createApp(deps);

  const res = await app.request('/api/uploads', { method: 'POST', headers: AUTH, body: uploadForm() });

  assertEquals(res.status, 503);
  assertEquals(db.tables.moderation_events.length, 0);
  assertEquals(db.rpcCalls.filter((r) => r.name === 'fn_increment_strike').length, 0);
});

Deno.test('generate: prompt moderation unavailable → 503 with no charge and no provider call', async () => {
  const moderation = fakeModeration();
  moderation.next({ state: 'unavailable', reason: 'moderation_unreachable', retryAfterSeconds: 10 });
  const deps = testDeps({ moderate: moderation.moderate });
  const db = deps.admin as unknown as FakeDb;
  subscribed(db);
  db.tables.models = [{ id: 'flux', enabled: true, min_plan: 'studio' }];
  const app = createApp(deps);

  const res = await app.request('/api/generations', {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'generate', familyId: 'flux', prompt: 'a cat', batch: 1, settings: { aspectRatio: '1:1', resolution: '1MP' } }),
  });

  assertEquals(res.status, 503);
  assertEquals((await res.json()).error.code, 'moderation_unavailable');
  assertEquals(db.rpcCalls.filter((r) => r.name === 'fn_charge_and_generate').length, 0);
});

Deno.test('thumb: poster is moderated before it is stored', async () => {
  const moderation = fakeModeration();
  moderation.next({ state: 'blocked', categories: { sexual: 0.8 } });
  const deps = testDeps({ moderate: moderation.moderate });
  const db = deps.admin as unknown as FakeDb;
  db.tables.moderation_events = [];
  db.tables.generations = [
    { id: 'v1', user_id: TEST_USER, kind: 'video', status: 'done', storage_backend: 'r2', thumb_path: null },
  ];
  const app = createApp(deps);

  const form = new FormData();
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
  form.append('file', new Blob([jpeg as BlobPart], { type: 'image/jpeg' }), 'p.jpg');
  const res = await app.request('/api/generations/v1/thumb', { method: 'POST', headers: AUTH, body: form });

  assertEquals(res.status, 422);
  assertEquals(db.tables.generations[0].thumb_path, null);
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all api/moderation_routes_test.ts
```

Expected: FAIL to type-check (`Property 'flagged' does not exist`) — the same failure `deno check` reported at the end of Task 4.

- [ ] **Step 3: Add the shared helpers inside `createApp` in `app.ts`**

Insert beside `recordStrike`; replace that function with the checked version below:

```ts
  /** One response for a moderation outage: readable, retryable, never charged. */
  function moderationFailure(
    c: Context,
    decision: Extract<ModerationDecision, { state: 'unavailable' }>,
  ): Response {
    const res = fail(
      c,
      503,
      'moderation_unavailable',
      'Safety check is unavailable right now. Nothing was charged — please try again shortly.',
    );
    res.headers.set('retry-after', String(decision.retryAfterSeconds));
    console.error('moderation_unavailable', decision.reason);
    return res;
  }

  /** Copy the bytes into quarantine for an appeal, then delete the original.
   * A failed copy must not leave `moderation_events` pointing at nothing. */
  async function quarantine(userId: string, bucketPath: string, ext: string): Promise<string | null> {
    const target = `quarantine/${userId}/${crypto.randomUUID()}.${ext}`;
    const { error } = await admin.storage.from('uploads').copy(bucketPath, target);
    if (error) {
      console.error('quarantine_copy_failed', error.message);
      return null;
    }
    return target;
  }

  type ImageCheck =
    | { ok: true }
    | { ok: false; response: Response };

  /** Sign a just-written object and moderate it. Any failure to produce a real
   * signed URL is an outage, not a pass — we never call moderate() with an
   * undefined image. Blocked images are quarantined and striked here. */
  async function moderateStoredImage(
    c: Context,
    userId: string,
    path: string,
    ext: string,
  ): Promise<ImageCheck> {
    const { data: signed, error: signError } = await admin.storage
      .from('uploads')
      .createSignedUrl(path, 600);
    if (signError || !signed?.signedUrl) {
      await admin.storage.from('uploads').remove([path]);
      console.error('moderation_sign_failed', signError?.message ?? 'no signed url');
      return {
        ok: false,
        response: moderationFailure(c, {
          state: 'unavailable',
          reason: 'moderation_sign_failed',
          retryAfterSeconds: 10,
        }),
      };
    }
    const decision = await moderate({ imageUrl: signed.signedUrl });
    if (decision.state === 'unavailable') {
      await admin.storage.from('uploads').remove([path]);
      return { ok: false, response: moderationFailure(c, decision) };
    }
    if (decision.state === 'blocked') {
      return refuseBlockedImage(c, userId, path, ext, decision.categories);
    }
    return { ok: true };
  }

  async function refuseBlockedImage(
    c: Context, userId: string, path: string, ext: string,
    categories: Record<string, number>,
  ): Promise<ImageCheck> {
      const kept = await quarantine(userId, path, ext);
      if (!kept) return { ok: false, response: moderationFailure(c, {
        state: 'unavailable', reason: 'quarantine_copy_failed', retryAfterSeconds: 10,
      }) };
      await recordStrike(userId, 'upload', null, categories, kept);
      const { error: removeError } = await admin.storage.from('uploads').remove([path]);
      if (removeError) console.error('quarantined_original_cleanup_failed', { path });
      return {
        ok: false,
        response: fail(c, 422, 'content_policy', 'This image violates our content policy.'),
      };
  }
```

Remove an original upload only after quarantine and evidence succeed; scratch routes always attempt cleanup in `finally`. A failed copy returns 503 with no evidence, strike, charge or submission.

Add `import type { ModerationDecision } from './_shared/moderation.ts';` to the module-scope imports, and change `recordStrike`'s signature so a missing quarantine path is explicit:

```ts
  async function recordStrike(
    userId: string,
    source: 'prompt' | 'upload',
    prompt: string | null,
    categories: Record<string, number>,
    quarantinePath?: string,
  ): Promise<void> {
    const { error } = await admin.from('moderation_events').insert({
      user_id: userId,
      source,
      prompt,
      categories,
      quarantine_path: quarantinePath ?? null,
    });
    if (error) throw new Error('moderation_event_insert_failed');
    const { error: strikeError } = await admin.rpc('fn_increment_strike', { p_user: userId });
    if (strikeError) throw new Error('moderation_strike_failed');
  }
```

- [ ] **Step 4: Rewrite the prompt check in `POST /generations`**

Replace the current block (evidence L1136–1141):

```ts
  // Moderation gate — BEFORE charge and BEFORE any provider call.
  const mod = await moderate({ text: effectivePrompt });
  if (mod.flagged) {
    await recordStrike(userId, 'prompt', prompt, mod.categories);
    return fail(c, 422, 'content_policy', 'This prompt violates our content policy.');
  }
```

with:

```ts
  // Moderation gate — BEFORE charge and BEFORE any provider call. An outage
  // refuses the request; it never silently lets an unchecked prompt through.
  const promptDecision = await moderate({ text: effectivePrompt });
  if (promptDecision.state === 'unavailable') return moderationFailure(c, promptDecision);
  if (promptDecision.state === 'blocked') {
    await recordStrike(userId, 'prompt', prompt, promptDecision.categories);
    return fail(c, 422, 'content_policy', 'This prompt violates our content policy.');
  }
```

- [ ] **Step 5: Rewrite the video reference check in `prepareVideo`**

Replace the loop (evidence L992–1001):

```ts
  for (const path of referencePaths) {
    const { data: signed, error } = await admin.storage.from('uploads').createSignedUrl(path, REF_SIGN_TTL_S);
    if (error || !signed) return fail(c, 400, 'bad_reference_count', 'Reference upload not found.');
    const mod = await moderate({ imageUrl: signed.signedUrl });
    if (mod.flagged) {
      await recordStrike(userId, 'upload', null, mod.categories, path);
      return fail(c, 422, 'content_policy', 'A reference image was blocked by moderation.');
    }
    prep.referenceUrls.push(signed.signedUrl);
  }
  return prep;
```

with:

```ts
  for (const path of referencePaths) {
    const { data: signed, error } = await admin.storage.from('uploads').createSignedUrl(path, REF_SIGN_TTL_S);
    if (error || !signed) return fail(c, 400, 'bad_reference_count', 'Reference upload not found.');
    const decision = await moderate({ imageUrl: signed.signedUrl });
    if (decision.state === 'unavailable') return moderationFailure(c, decision);
    if (decision.state === 'blocked') {
      await recordStrike(userId, 'upload', null, decision.categories, path);
      return fail(c, 422, 'content_policy', 'A reference image was blocked by moderation.');
    }
    prep.referenceUrls.push(signed.signedUrl);
  }
  return prep;
```

- [ ] **Step 6: Rewrite `POST /uploads` to check its own storage write**

Replace evidence L1667–1684:

```ts
  const path = `${userId}/${crypto.randomUUID()}.${ext}`;
  const { error: upErr } = await admin.storage.from('uploads').upload(path, bytes, {
    contentType: `image/${ext === 'jpg' ? 'jpeg' : ext}`,
  });
  if (upErr) return fail(c, 400, 'upload_failed', 'Storage rejected the file');

  const check = await moderateStoredImage(c, userId, path, ext);
  if (!check.ok) return check.response;

  const { data: signed } = await admin.storage.from('uploads').createSignedUrl(path, 600);
  return c.json({ uploadId: path, url: signed?.signedUrl ?? '' });
```

- [ ] **Step 7: Rewrite the `/edits/save` and `/library/import` scratch blocks**

In `POST /edits/save`, replace evidence L1926–1937:

```ts
  // Moderation BEFORE anything persists outside quarantine reach. A failed
  // scratch write is an outage: we must not write to `media` unchecked.
  const scratch = `scratch/${userId}/${crypto.randomUUID()}.png`;
  const { error: scratchErr } = await admin.storage
    .from('uploads')
    .upload(scratch, bytes, { contentType: 'image/png' });
  if (scratchErr) {
    return moderationFailure(c, { state: 'unavailable', reason: 'scratch_write_failed', retryAfterSeconds: 10 });
  }
  let saveCheck: ImageCheck;
  try {
    saveCheck = await moderateStoredImage(c, userId, scratch, 'png');
  } finally {
    const { error: cleanupError } = await admin.storage.from('uploads').remove([scratch]);
    if (cleanupError) console.error('scratch_cleanup_failed', { path: scratch });
  }
  if (!saveCheck.ok) return saveCheck.response;
```

In `POST /library/import`, replace evidence L1991–2002 with the same shape, using the sniffed `ext` and `contentType`:

```ts
  // Moderate BEFORE the image enters the library.
  const scratch = `scratch/${userId}/${crypto.randomUUID()}.${ext}`;
  const { error: scratchErr } = await admin.storage.from('uploads').upload(scratch, bytes, { contentType });
  if (scratchErr) {
    return moderationFailure(c, { state: 'unavailable', reason: 'scratch_write_failed', retryAfterSeconds: 10 });
  }
  let importCheck: ImageCheck;
  try {
    importCheck = await moderateStoredImage(c, userId, scratch, ext);
  } finally {
    const { error: cleanupError } = await admin.storage.from('uploads').remove([scratch]);
    if (cleanupError) console.error('scratch_cleanup_failed', { path: scratch });
  }
  if (!importCheck.ok) return importCheck.response;
```

- [ ] **Step 8: Moderate the video poster in `POST /generations/:id/thumb`**

After the JPEG sniff (evidence L1706) and before `storageFor(backend).put(...)`, insert:

```ts
  // Posters are client-captured bytes, not a vetted server render: they cross
  // the same gate as any other user image before they are stored or served.
  const posterScratch = `scratch/${userId}/${crypto.randomUUID()}.jpg`;
  const { error: posterErr } = await admin.storage
    .from('uploads')
    .upload(posterScratch, bytes, { contentType: 'image/jpeg' });
  if (posterErr) {
    return moderationFailure(c, { state: 'unavailable', reason: 'scratch_write_failed', retryAfterSeconds: 10 });
  }
  let posterCheck: ImageCheck;
  try {
    posterCheck = await moderateStoredImage(c, userId, posterScratch, 'jpg');
  } finally {
    const { error: cleanupError } = await admin.storage.from('uploads').remove([posterScratch]);
    if (cleanupError) console.error('scratch_cleanup_failed', { path: posterScratch });
  }
  if (!posterCheck.ok) return posterCheck.response;
```

- [ ] **Step 9: Run the moderation route tests**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all api/moderation_routes_test.ts
```

Expected: `7 passed | 0 failed`.

- [ ] **Step 10: Run the full edge suite and type-check**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno check api/index.ts api/app.ts stripe-webhook/index.ts appstore-webhook/index.ts && deno test --allow-all _shared api
```

Expected: `77 passed | 0 failed` (62 + 8 moderation unit + 7 moderation route). User commits Tasks 4 and 5 together.

**Operational note for the release runbook (P9 / T19):** this gate now fails closed, so an OpenAI moderation outage stops all generation, upload, save, import and poster traffic with a 503. Add an alert on the `moderation_unavailable` rate before enabling paid traffic.

---

## Task 6: Upload ownership registry

**Files:**
- Create: `supabase/migrations/0017_upload_registry.sql`
- Create: `supabase/functions/_shared/image-size.ts`, `supabase/functions/_shared/image-size_test.ts`
- Create: `supabase/functions/api/services/reference-resolver.ts`, `supabase/functions/api/services/reference-resolver_test.ts`
- Modify: `supabase/functions/api/app.ts` (`POST /uploads` registers; references resolve through the resolver)

**Interfaces:**
- Consumes: `FakeDb`, `createApp`, `testDeps`, `moderateStoredImage`.
- Produces:
  ```ts
  // image-size.ts
  export interface ImageSize { width: number; height: number }
  export function imageSize(bytes: Uint8Array): ImageSize | null;

  // reference-resolver.ts
  export type ReferenceError = 'not_found' | 'not_owned' | 'not_moderated' | 'wrong_purpose';
  export interface OwnedUpload { path: string; mime: string; width: number; height: number }
  export function isCanonicalUploadPath(path: string, userId: string): boolean;
  export function resolveOwnedUpload(
    admin: SupabaseClient, userId: string, uploadId: string, purpose: 'reference' | 'persona-photo',
  ): Promise<OwnedUpload | ReferenceError>;
  ```

- [ ] **Step 1: Confirm the deployed migration inventory before adding a file**

Ask the user to run this in the Supabase SQL editor for project `bnorhcxhvxydkgvcxjad` and paste the result:

```sql
select name from supabase_migrations.schema_migrations order by version;
```

Record the answer in the plan's execution log. Do not create `0017_*` until you have confirmed that `0016_video.sql` either is applied or is queued ahead of this one; if `0016` is still unapplied, this file must be applied after it and the executor must say so in the commit message. Never renumber an applied migration.

- [ ] **Step 2: Write the failing dimension-sniffing test**

Create `supabase/functions/_shared/image-size_test.ts`:

```ts
import { assertEquals } from 'jsr:@std/assert';
import { imageSize } from './image-size.ts';

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function jpeg(width: number, height: number): Uint8Array {
  // SOI, then one SOF0 segment: FF C0, length 0x0011, precision, height, width.
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0x03]);
  const view = new DataView(bytes.buffer);
  view.setUint16(7, height);
  view.setUint16(9, width);
  return bytes;
}

Deno.test('reads png dimensions from IHDR', () => {
  assertEquals(imageSize(png(1920, 1080)), { width: 1920, height: 1080 });
});

Deno.test('reads jpeg dimensions from SOF0', () => {
  assertEquals(imageSize(jpeg(800, 600)), { width: 800, height: 600 });
});

Deno.test('unknown bytes return null', () => {
  assertEquals(imageSize(new Uint8Array([1, 2, 3, 4])), null);
});

Deno.test('truncated png returns null rather than guessing', () => {
  assertEquals(imageSize(png(10, 10).slice(0, 12)), null);
});
```

- [ ] **Step 3: Run to verify it fails**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all _shared/image-size_test.ts
```

Expected: FAIL — `Module not found "file:///.../_shared/image-size.ts"`.

- [ ] **Step 4: Write `_shared/image-size.ts`**

```ts
// Pixel dimensions straight from the file header — no decoding, so a
// decompression bomb is rejected before anything allocates its pixels.
// Covers exactly the three types sniffImage() accepts.

export interface ImageSize { width: number; height: number }

function pngSize(bytes: Uint8Array, view: DataView): ImageSize | null {
  if (bytes.length < 24) return null;
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (!isPng) return null;
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function jpegSize(bytes: Uint8Array, view: DataView): ImageSize | null {
  if (bytes.length < 4) return null;
  if (!(bytes[0] === 0xff && bytes[1] === 0xd8)) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    const length = view.getUint16(offset + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

function webpSize(bytes: Uint8Array, view: DataView): ImageSize | null {
  if (bytes.length < 30) return null;
  const isRiff = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
  const isWebp = bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  if (!isRiff || !isWebp) return null;
  const fourcc = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  if (fourcc === 'VP8X') {
    const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
    const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
    return { width, height };
  }
  if (fourcc === 'VP8L') {
    const bits = view.getUint32(21, true);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  if (fourcc === 'VP8 ') {
    return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
  }
  return null;
}

export function imageSize(bytes: Uint8Array): ImageSize | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const png = pngSize(bytes, view);
  if (png) return png;
  const webp = webpSize(bytes, view);
  if (webp) return webp;
  return jpegSize(bytes, view);
}
```

- [ ] **Step 5: Run to verify it passes**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all _shared/image-size_test.ts
```

Expected: `4 passed | 0 failed`.

- [ ] **Step 6: Write the failing resolver test**

Create `supabase/functions/api/services/reference-resolver_test.ts`:

```ts
import { assertEquals } from 'jsr:@std/assert';
import { FakeDb, OTHER_USER, TEST_USER } from '../testing/fakes.ts';
import { isCanonicalUploadPath, resolveOwnedUpload } from './reference-resolver.ts';

const MINE = `${TEST_USER}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png`;
const THEIRS = `${OTHER_USER}/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.png`;

function dbWith(rows: Record<string, unknown>[]): FakeDb {
  const db = new FakeDb();
  db.tables.uploads = rows;
  return db;
}

Deno.test('canonical path check rejects traversal, quarantine and foreign prefixes', () => {
  assertEquals(isCanonicalUploadPath(MINE, TEST_USER), true);
  assertEquals(isCanonicalUploadPath(THEIRS, TEST_USER), false);
  assertEquals(isCanonicalUploadPath(`quarantine/${TEST_USER}/x.png`, TEST_USER), false);
  assertEquals(isCanonicalUploadPath(`scratch/${TEST_USER}/x.png`, TEST_USER), false);
  assertEquals(isCanonicalUploadPath(`${TEST_USER}/../../etc/passwd`, TEST_USER), false);
  assertEquals(isCanonicalUploadPath(`persona-zips/${TEST_USER}/p.zip`, TEST_USER), false);
});

Deno.test('own, moderated upload resolves', async () => {
  const db = dbWith([
    { id: 'u1', user_id: TEST_USER, path: MINE, purpose: 'reference', mime: 'image/png', width: 1024, height: 1024, moderation: 'allowed' },
  ]);
  const result = await resolveOwnedUpload(db as never, TEST_USER, MINE, 'reference');
  assertEquals(result, { path: MINE, mime: 'image/png', width: 1024, height: 1024 });
});

Deno.test('another user\'s upload is not owned even when the row exists', async () => {
  const db = dbWith([
    { id: 'u2', user_id: OTHER_USER, path: THEIRS, purpose: 'reference', mime: 'image/png', width: 10, height: 10, moderation: 'allowed' },
  ]);
  assertEquals(await resolveOwnedUpload(db as never, TEST_USER, THEIRS, 'reference'), 'not_owned');
});

Deno.test('an unregistered path is not found even if it looks canonical', async () => {
  const db = dbWith([]);
  assertEquals(await resolveOwnedUpload(db as never, TEST_USER, MINE, 'reference'), 'not_found');
});

Deno.test('an unmoderated upload is refused', async () => {
  const db = dbWith([
    { id: 'u3', user_id: TEST_USER, path: MINE, purpose: 'reference', mime: 'image/png', width: 10, height: 10, moderation: 'pending' },
  ]);
  assertEquals(await resolveOwnedUpload(db as never, TEST_USER, MINE, 'reference'), 'not_moderated');
});

Deno.test('a persona photo cannot be used as a generation reference', async () => {
  const db = dbWith([
    { id: 'u4', user_id: TEST_USER, path: MINE, purpose: 'persona-photo', mime: 'image/png', width: 10, height: 10, moderation: 'allowed' },
  ]);
  assertEquals(await resolveOwnedUpload(db as never, TEST_USER, MINE, 'reference'), 'wrong_purpose');
});
```

- [ ] **Step 7: Run to verify it fails**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all api/services/reference-resolver_test.ts
```

Expected: FAIL — `Module not found "file:///.../api/services/reference-resolver.ts"`.

- [ ] **Step 8: Write `api/services/reference-resolver.ts`**

```ts
// One owner check for every path a caller can name. The service-role client
// bypasses storage RLS, so a raw caller-supplied key must never reach it: a
// reference is only usable when its registry row says this user owns it, it was
// stored for this purpose, and moderation allowed it.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';

export type UploadPurpose = 'reference' | 'persona-photo';
export type ReferenceError = 'not_found' | 'not_owned' | 'not_moderated' | 'wrong_purpose';

export interface OwnedUpload {
  path: string;
  mime: string;
  width: number;
  height: number;
}

/** `<uuid>/<uuid>.<ext>` under the caller's own prefix. Rejects quarantine/,
 * scratch/, persona-zips/ and anything containing a path segment we did not
 * write ourselves. */
const CANONICAL = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(png|jpg|jpeg|webp)$/i;

export function isCanonicalUploadPath(path: string, userId: string): boolean {
  if (!CANONICAL.test(path)) return false;
  return path.startsWith(`${userId}/`);
}

export async function resolveOwnedUpload(
  admin: SupabaseClient,
  userId: string,
  uploadId: string,
  purpose: UploadPurpose,
): Promise<OwnedUpload | ReferenceError> {
  if (!isCanonicalUploadPath(uploadId, userId)) return 'not_owned';
  const { data } = await admin
    .from('uploads')
    .select('user_id,path,purpose,mime,width,height,moderation')
    .eq('path', uploadId)
    .maybeSingle();
  if (!data) return 'not_found';
  if (data.user_id !== userId) return 'not_owned';
  if (data.purpose !== purpose) return 'wrong_purpose';
  if (data.moderation !== 'allowed') return 'not_moderated';
  return {
    path: data.path as string,
    mime: data.mime as string,
    width: Number(data.width),
    height: Number(data.height),
  };
}
```

- [ ] **Step 9: Run to verify it passes**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all api/services/reference-resolver_test.ts
```

Expected: `6 passed | 0 failed`.

- [ ] **Step 10: Write the migration**

Create `supabase/migrations/0017_upload_registry.sql`:

```sql
-- 0017: upload ownership registry.
-- The gateway signs `uploads` objects with the service-role client, which
-- bypasses storage RLS. Before this table, ownership existed only as a path
-- prefix that nothing checked on the image-reference path. Every usable upload
-- now has a row naming its owner, why it was stored, and whether moderation
-- allowed it; a path with no row cannot be referenced.
-- (written 2026-09-20; apply AFTER 0016_video.sql)

create table public.uploads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles on delete cascade,
  path text not null unique,
  purpose text not null check (purpose in ('reference', 'persona-photo')),
  mime text not null,
  bytes int not null,
  width int not null,
  height int not null,
  moderation text not null default 'pending' check (moderation in ('pending', 'allowed', 'blocked')),
  created_at timestamptz not null default now()
);

create index uploads_user_idx on public.uploads (user_id, created_at desc);

alter table public.uploads enable row level security;
```

- [ ] **Step 11: Register uploads and enforce a pixel ceiling in `POST /uploads`**

Add to the module-scope constants in `app.ts`:

```ts
/** Pre-allocation guard: nothing downstream needs more than 50 MP, and a larger
 * header is a decompression bomb, not a photo. */
const UPLOAD_MAX_PIXELS = 50 * 1_000_000;
```

Add the import:

```ts
import { imageSize } from './_shared/image-size.ts';
import { resolveOwnedUpload, type ReferenceError } from './services/reference-resolver.ts';
```

Rewrite the body of `POST /uploads` after the `sniffImage` guard:

```ts
  const dims = imageSize(bytes);
  if (!dims) return fail(c, 400, 'upload_failed', 'Could not read the image dimensions');
  if (dims.width * dims.height > UPLOAD_MAX_PIXELS) {
    return fail(c, 400, 'upload_too_large', 'Image is too large — keep it under 50 megapixels');
  }

  const mime = `image/${ext === 'jpg' ? 'jpeg' : ext}`;
  const path = `${userId}/${crypto.randomUUID()}.${ext}`;
  const { error: upErr } = await admin.storage.from('uploads').upload(path, bytes, { contentType: mime });
  if (upErr) return fail(c, 400, 'upload_failed', 'Storage rejected the file');

  // Registry row first, as `pending`: an upload that never reaches `allowed`
  // can never be referenced, and deletion (P6/T08) still has its path.
  const { data: registered, error: regErr } = await admin
    .from('uploads')
    .insert({
      user_id: userId,
      path,
      purpose: 'reference',
      mime,
      bytes: file.size,
      width: dims.width,
      height: dims.height,
      moderation: 'pending',
    })
    .select('id')
    .single();
  if (regErr || !registered) {
    await admin.storage.from('uploads').remove([path]);
    logError(c, 'upload_register_failed', new Error(regErr?.message ?? 'no row'));
    return fail(c, 500, 'upload_failed', 'Could not record the upload');
  }

  const check = await moderateStoredImage(c, userId, path, ext);
  if (!check.ok) {
    await admin.from('uploads').update({ moderation: 'blocked' }).eq('id', registered.id);
    return check.response;
  }
  await admin.from('uploads').update({ moderation: 'allowed' }).eq('id', registered.id);

  const { data: signed } = await admin.storage.from('uploads').createSignedUrl(path, 600);
  return c.json({ uploadId: path, url: signed?.signedUrl ?? '' });
```

- [ ] **Step 12: Route every reference through the resolver**

Add this helper inside `createApp`, next to `moderationFailure`:

```ts
  const REFERENCE_MESSAGES: Record<ReferenceError, string> = {
    not_found: 'That reference image is no longer available — upload it again.',
    not_owned: 'That reference image does not belong to you.',
    not_moderated: 'That reference image has not finished its safety check.',
    wrong_purpose: 'That image was not uploaded as a reference.',
  };

  function referenceFailure(c: Context, err: ReferenceError): Response {
    const status = err === 'not_found' ? 404 : 403;
    return fail(c, status, 'invalid_reference', REFERENCE_MESSAGES[err]);
  }
```

In `prepareVideo`, replace the prefix check (evidence L954–956) with a resolver loop, keeping the count check above it unchanged:

```ts
  for (const path of referencePaths) {
    const owned = await resolveOwnedUpload(admin, userId, path, 'reference');
    if (typeof owned === 'string') return referenceFailure(c, owned);
  }
```

In `POST /personas/:id/train`, replace the `startsWith` filter (evidence L1833–1837) with:

```ts
  const photoIds = Array.isArray(body?.photoUploadIds)
    ? (body.photoUploadIds as unknown[]).filter((p): p is string => typeof p === 'string')
    : [];
```

and, immediately after the count/duplicate guard, add:

```ts
  for (const photoId of photoIds) {
    const owned = await resolveOwnedUpload(admin, userId, photoId, 'persona-photo');
    if (typeof owned === 'string') return referenceFailure(c, owned);
  }
```

Persona photos are uploaded through the same `POST /uploads` route, so add a `purpose` form field to that route: read `const purpose = form?.get('purpose') === 'persona-photo' ? 'persona-photo' : 'reference';` and store it instead of the hard-coded `'reference'`. The mobile and web clients send no `purpose` today and therefore keep getting `'reference'`; the persona upload call sites are updated in P8 Task "persona upload purpose" — until then, persona training must accept both purposes. Implement that by passing `'persona-photo'` and falling back once:

```ts
  for (const photoId of photoIds) {
    const owned = await resolveOwnedUpload(admin, userId, photoId, 'persona-photo');
    if (owned === 'wrong_purpose') continue; // legacy 'reference' uploads, pre-P8
    if (typeof owned === 'string') return referenceFailure(c, owned);
  }
```

- [ ] **Step 13: Add the route tests**

Create `supabase/functions/api/reference_ownership_test.ts`:

```ts
import { assertEquals } from 'jsr:@std/assert';
import { createApp } from './app.ts';
import { FakeDb, OTHER_USER, TEST_USER, fakeAdapter, testDeps } from './testing/fakes.ts';

const AUTH = { authorization: 'Bearer test-token' };
const THEIRS = `${OTHER_USER}/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.png`;

function ready(db: FakeDb) {
  db.tables.subscriptions = [
    { user_id: TEST_USER, plan: 'pro', status: 'active', current_period_end: '2099-01-01T00:00:00Z' },
  ];
  db.tables.models = [{ id: 'flux', enabled: true, min_plan: 'studio' }];
  db.tables.uploads = [
    { id: 'u-theirs', user_id: OTHER_USER, path: THEIRS, purpose: 'reference', mime: 'image/png', width: 8, height: 8, moderation: 'allowed' },
  ];
  db.rpcHandlers.fn_charge_and_generate = () => {
    throw new Error('charge must not be reached');
  };
}

Deno.test('a foreign upload cannot be used as an image reference', async () => {
  const provider = fakeAdapter();
  const deps = testDeps({ adapterFor: () => provider.adapter });
  const db = deps.admin as unknown as FakeDb;
  ready(db);
  const app = createApp(deps);

  const res = await app.request('/api/generations', {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({
      op: 'generate',
      familyId: 'flux',
      prompt: 'a cat',
      batch: 1,
      settings: { aspectRatio: '1:1', resolution: '1MP' },
      referenceUploadId: THEIRS,
    }),
  });

  assertEquals(res.status, 403);
  assertEquals((await res.json()).error.code, 'invalid_reference');
  assertEquals(provider.submits.length, 0);
  assertEquals(db.rpcCalls.filter((r) => r.name === 'fn_charge_and_generate').length, 0);
});

Deno.test('a quarantine path cannot be used as an image reference', async () => {
  const provider = fakeAdapter();
  const deps = testDeps({ adapterFor: () => provider.adapter });
  const db = deps.admin as unknown as FakeDb;
  ready(db);
  const app = createApp(deps);

  const res = await app.request('/api/generations', {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({
      op: 'generate',
      familyId: 'flux',
      prompt: 'a cat',
      batch: 1,
      settings: { aspectRatio: '1:1', resolution: '1MP' },
      referenceUploadId: `quarantine/${TEST_USER}/x.png`,
    }),
  });

  assertEquals(res.status, 403);
  assertEquals(provider.submits.length, 0);
});

Deno.test('a pending parent cannot be used as an image reference', async () => {
  const provider = fakeAdapter();
  const deps = testDeps({ adapterFor: () => provider.adapter });
  const db = deps.admin as unknown as FakeDb;
  ready(db);
  db.tables.generations = [
    { id: 'p1', user_id: TEST_USER, kind: 'image', status: 'pending', media_path: null, settings: {}, price_credits: 0 },
  ];
  const app = createApp(deps);

  const res = await app.request('/api/generations', {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({
      op: 'edit',
      familyId: 'edit-bg',
      prompt: 'cut out',
      batch: 1,
      settings: { aspectRatio: '1:1' },
      parentId: 'p1',
    }),
  });

  assertEquals(res.status, 400);
  assertEquals((await res.json()).error.code, 'parent_not_ready');
  assertEquals(provider.submits.length, 0);
});
```

- [ ] **Step 14: Make the parent check strict enough to pass the third test**

Replace the image-parent lookup in `POST /generations` (evidence L1151–1159):

```ts
  async function imageParentUrl(parentId: string, userId: string): Promise<string | Response> {
    const { data: parent, error } = await admin.from('generations')
      .select('id,kind,status,media_path,storage_backend')
      .eq('id', parentId).eq('user_id', userId).maybeSingle();
    if (error) return fail(c, 503, 'reference_unavailable', 'Could not read your image. Try again.');
    if (!parent) return fail(c, 404, 'not_found', 'Parent generation not found');
    if (parent.kind !== MediaKind.Image) return fail(c, 400, 'invalid_parent', 'Pick an image to edit.');
    if (parent.status !== 'done' || !parent.media_path) return fail(c, 400, 'parent_not_ready', 'That image is not ready.');
    return signStored(parent.storage_backend, parent.media_path);
  }
  const parentReference = parentId && !video ? await imageParentUrl(parentId, userId) : undefined;
  if (parentReference instanceof Response) return parentReference;
  referenceUrl = parentReference;
```

- [ ] **Step 14a: Add the real database ownership/RLS gate**

Create `supabase/tests/upload_ownership.sql`. Seed synthetic users A/B in a disposable local Supabase stack and pending/allowed/blocked uploads with all required columns: `purpose, path, mime, bytes, width, height`. Under A's authenticated JWT claims, B's rows/objects must be unreadable; A cannot mark an upload allowed, rewrite ownership, or bypass purpose checks; anon cannot read/mutate the registry. Exercise service-role writes separately. Roll back fixtures.

```sql
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}', true);
do $$
begin
  if exists (select 1 from public.uploads where user_id = '00000000-0000-0000-0000-00000000000b')
  then raise exception 'RLS exposed foreign upload'; end if;
end $$;
```

Run `psql "$VANSEN_LOCAL_DB" -X -v ON_ERROR_STOP=1 -f supabase/tests/upload_ownership.sql`. Add real gateway integration cases for owned allowed, foreign, deleted, unmoderated and wrong-purpose IDs; rejection must precede charge and dispatch. Missing DB is blocked, never a fake-only PASS. Inject moderator/signing throws in scratch-route tests and assert cleanup is attempted on every exit. P6 makes failed cleanup durable; retain error evidence until then.

- [ ] **Step 15: Run everything**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno check api/index.ts api/app.ts && deno test --allow-all _shared api
```

Expected: `90 passed | 0 failed` (77 + 4 image-size + 6 resolver + 3 reference-ownership). User commits.

---

## Task 7: Upload-as-reference reaches the provider (R28)

**Files:**
- Modify: `supabase/functions/api/app.ts` (`POST /generations` reference branch and the `invalid_parent` guard)
- Modify: `src/app/features/workspace/workspace-page.ts:355–359`
- Test: `supabase/functions/api/reference_contract_test.ts` (create), `src/app/features/workspace/workspace-page.spec.ts` (extend)

**Interfaces:**
- Consumes: `resolveOwnedUpload` (Task 6).
- Produces: the settled contract — **an uploaded reference travels with `op = generate` and `referenceUploadId`; a library parent travels with `op = edit` and `parentId`.** `SubmitCtx.referenceUrl` is set in both cases. The adapter half (making OpenAI actually send it on generate) is P3 Task 3.

**Why this is a blocker:** today `workspace-page.ts` sets `op = edit` whenever any reference is present, an uploaded reference produces no `parentId`, and the gateway rejects `edit` without `parentId` at evidence L1047–1048 with `invalid_parent`. Uploading a reference image therefore fails for every image family before a charge is taken.

- [ ] **Step 1: Write the failing gateway test**

Create `supabase/functions/api/reference_contract_test.ts`:

```ts
import { assertEquals } from 'jsr:@std/assert';
import { createApp } from './app.ts';
import { FakeDb, TEST_USER, fakeAdapter, testDeps } from './testing/fakes.ts';

const AUTH = { authorization: 'Bearer test-token' };
const MINE = `${TEST_USER}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png`;

function ready(db: FakeDb, familyId: string) {
  db.tables.subscriptions = [
    { user_id: TEST_USER, plan: 'pro', status: 'active', current_period_end: '2099-01-01T00:00:00Z' },
  ];
  db.tables.models = [{ id: familyId, enabled: true, min_plan: 'studio' }];
  db.tables.uploads = [
    { id: 'u1', user_id: TEST_USER, path: MINE, purpose: 'reference', mime: 'image/png', width: 1024, height: 1024, moderation: 'allowed' },
  ];
  db.storage.from('uploads').upload(MINE, new Uint8Array([1]), { contentType: 'image/png' });
  db.rpcHandlers.fn_charge_and_generate = (args) => {
    const items = args.p_items as Record<string, unknown>[];
    return items.map((item, i) => ({
      id: `g${i}`,
      user_id: TEST_USER,
      kind: item.kind,
      family_id: item.familyId,
      family_name: item.familyName,
      op: item.op,
      prompt: item.prompt,
      settings: item.settings,
      price_credits: item.priceCredits,
      status: 'pending',
      media_path: null,
    }));
  };
}

for (const familyId of ['nano-banana', 'gpt-image', 'flux', 'seedream']) {
  Deno.test(`${familyId}: an uploaded reference charges once and reaches the adapter`, async () => {
    const provider = fakeAdapter();
    const deps = testDeps({ adapterFor: () => provider.adapter });
    const db = deps.admin as unknown as FakeDb;
    ready(db, familyId);
    const app = createApp(deps);

    const res = await app.request('/api/generations', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        op: 'generate',
        familyId,
        prompt: 'a cat wearing this hat',
        batch: 1,
        settings: { aspectRatio: '1:1', resolution: familyId === 'flux' ? '1MP' : '1K', version: familyId === 'gpt-image' ? '2' : undefined, quality: familyId === 'gpt-image' ? 'medium' : undefined },
        referenceUploadId: MINE,
      }),
    });

    assertEquals(res.status, 200);
    assertEquals(db.rpcCalls.filter((r) => r.name === 'fn_charge_and_generate').length, 1);
    assertEquals(provider.submits.length, 1);
    assertEquals(provider.submits[0].op, 'generate');
    assertEquals(typeof provider.submits[0].referenceUrl, 'string');
    assertEquals(provider.submits[0].referenceUrl?.includes(MINE), true);
  });
}

Deno.test('a reference is refused for a family that takes no image input', async () => {
  const provider = fakeAdapter();
  const deps = testDeps({ adapterFor: () => provider.adapter });
  const db = deps.admin as unknown as FakeDb;
  ready(db, 'veo');
  const app = createApp(deps);

  const res = await app.request('/api/generations', {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({
      op: 'generate',
      familyId: 'veo',
      prompt: 'a cat',
      batch: 1,
      settings: { aspectRatio: '16:9', mode: 't2v', durationS: 4, resolution: '1080p' },
      referenceUploadId: MINE,
    }),
  });

  assertEquals(res.status, 400);
  assertEquals((await res.json()).error.code, 'reference_unsupported');
  assertEquals(provider.submits.length, 0);
});

Deno.test('edit without a parent is still rejected', async () => {
  const provider = fakeAdapter();
  const deps = testDeps({ adapterFor: () => provider.adapter });
  const db = deps.admin as unknown as FakeDb;
  ready(db, 'edit-bg');
  const app = createApp(deps);

  const res = await app.request('/api/generations', {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'edit', familyId: 'edit-bg', prompt: 'x', batch: 1, settings: { aspectRatio: '1:1' } }),
  });

  assertEquals(res.status, 400);
  assertEquals((await res.json()).error.code, 'invalid_parent');
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all api/reference_contract_test.ts
```

Expected: FAIL — the four family tests report `referenceUrl` as `undefined` (the reference is signed today only when the path happens to exist, with no ownership check and no `imageInput` check), and `reference_unsupported` does not exist.

- [ ] **Step 3: Resolve the uploaded reference through the registry**

Replace the reference block in `POST /generations` (evidence L1148–1163, as amended by Task 6 Step 14) with:

```ts
  const referenceUploadId = typeof body.referenceUploadId === 'string' ? body.referenceUploadId : null;
  if (video && referenceUploadId) return fail(c, 400, 'reference_unsupported', 'Use the video reference slots for this model.');
  if (parentId && referenceUploadId) return fail(c, 400, 'invalid_reference', 'Choose one reference source.');
  const family = familyById(familyId);
  if (referenceUploadId && !family?.capabilities.imageInput) return fail(c, 400, 'reference_unsupported', 'This model does not take a reference image.');
  async function uploadReferenceUrl(uploadId: string): Promise<string | Response> {
    const owned = await resolveOwnedUpload(admin, userId, uploadId, 'reference');
    if (typeof owned === 'string') return referenceFailure(c, owned);
    const { data: signed, error } = await admin.storage.from('uploads').createSignedUrl(owned.path, REF_SIGN_TTL_S);
    if (error || !signed?.signedUrl) return fail(c, 503, 'reference_unavailable', 'Could not read your reference image — try again.');
    return signed.signedUrl;
  }
  const parentReference = parentId && !video ? await imageParentUrl(parentId, userId) : undefined;
  if (parentReference instanceof Response) return parentReference;
  const uploadReference = referenceUploadId ? await uploadReferenceUrl(referenceUploadId) : undefined;
  if (uploadReference instanceof Response) return uploadReference;
  const referenceUrl = parentReference ?? uploadReference;
```

The `invalid_parent` guard at evidence L1047–1048 stays exactly as it is: `edit` and `upscale` still require a parent. What changes is that the client stops sending `edit` for an uploaded reference.

- [ ] **Step 4: Write the failing client test**

Append to `src/app/features/workspace/workspace-page.spec.ts` (match the file's existing TestBed arrangement):

```ts
it('sends an uploaded reference as a generate, not an edit', async () => {
  const created: CreateGenerationRequest[] = [];
  const store = TestBed.inject(GenerationStore);
  vi.spyOn(store, 'create').mockImplementation(async (req) => {
    created.push(req);
  });

  const page = TestBed.createComponent(WorkspacePage).componentInstance;
  await page.onGenerate({
    family: familyById('flux')!,
    prompt: 'a cat',
    settings: { aspectRatio: '1:1', resolution: '1MP' },
    batch: 1,
    referenceUploadId: 'user/abc.png',
  } as GenerateRequest);

  expect(created[0].op).toBe(GenerationOp.Generate);
  expect(created[0].referenceUploadId).toBe('user/abc.png');
  expect(created[0].parentId).toBeUndefined();
});

it('still sends a library reference as an edit', async () => {
  const created: CreateGenerationRequest[] = [];
  const store = TestBed.inject(GenerationStore);
  vi.spyOn(store, 'create').mockImplementation(async (req) => {
    created.push(req);
  });

  const page = TestBed.createComponent(WorkspacePage).componentInstance;
  await page.onGenerate({
    family: familyById('flux')!,
    prompt: 'a cat',
    settings: { aspectRatio: '1:1', resolution: '1MP' },
    batch: 1,
    referenceId: 'gen-1',
  } as GenerateRequest);

  expect(created[0].op).toBe(GenerationOp.Edit);
  expect(created[0].parentId).toBe('gen-1');
});
```

- [ ] **Step 5: Run to verify it fails**

```bash
cd /Users/user/IdeaProjects/vansen && npm test -- --watch=false
```

Expected: FAIL — the first new test reports `op` as `edit`.

- [ ] **Step 6: Fix the client op selection**

In `src/app/features/workspace/workspace-page.ts`, replace lines 353–359:

```ts
    // Personas are generate-only; the server routes them to its own family.
    // Video never becomes an Edit op — its modes live in settings.mode instead.
    const isImageEdit =
      req.settings.mode === undefined &&
      !!(req.referenceId || req.referenceUploadId) &&
      !req.personaId;
    const op = isImageEdit ? GenerationOp.Edit : GenerationOp.Generate;
```

with:

```ts
    // Only a LIBRARY reference is an edit — it has a parent generation to edit.
    // An uploaded reference has no parent, so it stays a generate and travels
    // as referenceUploadId; sending it as an edit made the gateway reject it
    // with invalid_parent before any model ran.
    // Personas are generate-only; video modes live in settings.mode instead.
    const isImageEdit =
      req.settings.mode === undefined && !!req.referenceId && !req.personaId;
    const op = isImageEdit ? GenerationOp.Edit : GenerationOp.Generate;
```

- [ ] **Step 7: Run both suites**

```bash
cd /Users/user/IdeaProjects/vansen && npm test -- --watch=false && cd supabase/functions && deno test --allow-all _shared api
```

Expected: vitest `242 passed`; deno `96 passed | 0 failed` (90 + 6 reference-contract). User commits.

**Carry-forward to P3:** `openai.ts:40` still gates the reference on `op === 'edit' || op === 'upscale'`, so GPT Image drops an uploaded reference even though the gateway now delivers it. P3 Task 3 fixes the adapter and asserts the outgoing multipart contains the image. Google and fal already forward `referenceUrl` on generate.

---

## Task 8: Family-level settings validation

**Files:**
- Create: `supabase/functions/api/services/request-validation.ts`, `supabase/functions/api/services/request-validation_test.ts`
- Modify: `supabase/functions/api/app.ts` (`POST /generations`, after the family is resolved)

**Interfaces:**
- Consumes: `familyById`, `ModelFamily`, `GenerationSettings` from `_shared/model-families.ts`.
- Produces:
  ```ts
  export type SettingsError =
    | { field: 'version' | 'resolution' | 'quality' | 'durationS' | 'aspectRatio' | 'audio'; value: string; allowed: string[] };
  export function validateSettings(family: ModelFamily, settings: GenerationSettings): SettingsError | null;
  ```

**Why:** `sanitizeSettings` only checks types and lengths, so `version: 'wat'` or `resolution: '9K'` reaches `providerCost`, falls through to a default price, and is charged. `durationS` accepts any value in `(0, 60]` regardless of what the family supports.

- [ ] **Step 1: Write the failing test**

Create `supabase/functions/api/services/request-validation_test.ts`:

```ts
import { assertEquals } from 'jsr:@std/assert';
import { familyById } from '../_shared/model-families.ts';
import { validateSettings } from './request-validation.ts';

Deno.test('accepts every catalogued combination for each family', () => {
  for (const familyId of ['nano-banana', 'gpt-image', 'flux', 'seedream']) {
    const family = familyById(familyId)!;
    const caps = family.capabilities;
    for (const version of caps.versions?.map((v) => v.value) ?? [undefined]) {
      for (const resolution of caps.resolutions?.map((r) => r.value) ?? [undefined]) {
        for (const quality of caps.qualities?.map((q) => q.value) ?? [undefined]) {
          const result = validateSettings(family, {
            aspectRatio: caps.aspectRatios[0],
            version,
            resolution,
            quality,
          });
          assertEquals(result, null, `${familyId} ${version}/${resolution}/${quality}`);
        }
      }
    }
  }
});

Deno.test('rejects an unknown version', () => {
  const family = familyById('gpt-image')!;
  const result = validateSettings(family, { aspectRatio: '1:1', version: '9', quality: 'medium', resolution: '1K' });
  assertEquals(result?.field, 'version');
  assertEquals(result?.allowed, ['1', '1.5', '2']);
});

Deno.test('rejects an unknown resolution', () => {
  const family = familyById('flux')!;
  const result = validateSettings(family, { aspectRatio: '1:1', resolution: '8MP' });
  assertEquals(result?.field, 'resolution');
});

Deno.test('rejects a version on a family that has none', () => {
  const family = familyById('flux')!;
  const result = validateSettings(family, { aspectRatio: '1:1', resolution: '1MP', version: '2' });
  assertEquals(result?.field, 'version');
  assertEquals(result?.allowed, []);
});

Deno.test('rejects an unsupported aspect ratio', () => {
  const family = familyById('seedream')!;
  const result = validateSettings(family, { aspectRatio: '21:9', resolution: '1K' });
  assertEquals(result?.field, 'aspectRatio');
});

Deno.test('rejects a duration the video family does not offer', () => {
  const family = familyById('kling')!;
  const result = validateSettings(family, { aspectRatio: '16:9', mode: 't2v', durationS: 7 });
  assertEquals(result?.field, 'durationS');
});

Deno.test('accepts a duration the video family does offer', () => {
  const family = familyById('kling')!;
  const durations = family.capabilities.durations!;
  const result = validateSettings(family, { aspectRatio: '16:9', mode: 't2v', durationS: durations[0] });
  assertEquals(result, null);
});

Deno.test('rejects audio on a family whose audio is not selectable', () => {
  const family = familyById('seedance')!;
  const caps = family.capabilities;
  if (caps.audio === 'selectable') return;
  const result = validateSettings(family, { aspectRatio: '16:9', mode: 't2v', durationS: caps.durations![0], audio: 'voice' });
  assertEquals(result?.field, 'audio');
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all api/services/request-validation_test.ts
```

Expected: FAIL — `Module not found "file:///.../api/services/request-validation.ts"`.

- [ ] **Step 3: Write `api/services/request-validation.ts`**

```ts
// The catalog is the contract. sanitizeSettings() proves a value is a
// well-formed string; this proves the selected family actually offers it, so a
// nonsense axis can never be priced by the providerCost() fallback and then
// charged for a request the provider will clamp or reject.
import type { GenerationSettings, ModelFamily } from '../_shared/model-families.ts';

export interface SettingsError {
  field: 'version' | 'resolution' | 'quality' | 'aspectRatio' | 'durationS' | 'audio';
  value: string;
  allowed: string[];
}

function offered(field: SettingsError['field'], value: string | undefined, allowed: string[]): SettingsError | null {
  if (value === undefined) return null;
  if (allowed.includes(value)) return null;
  return { field, value, allowed };
}

export function validateSettings(family: ModelFamily, settings: GenerationSettings): SettingsError | null {
  const caps = family.capabilities;

  const version = offered('version', settings.version, caps.versions?.map((v) => v.value) ?? []);
  if (version) return version;

  const resolution = offered('resolution', settings.resolution, caps.resolutions?.map((r) => r.value) ?? []);
  if (resolution) return resolution;

  const quality = offered('quality', settings.quality, caps.qualities?.map((q) => q.value) ?? []);
  if (quality) return quality;

  const aspect = offered('aspectRatio', settings.aspectRatio, caps.aspectRatios);
  if (aspect) return aspect;

  const durations = caps.durations ?? [];
  if (settings.durationS !== undefined && !durations.includes(settings.durationS)) {
    return { field: 'durationS', value: String(settings.durationS), allowed: durations.map(String) };
  }

  if (settings.audio !== undefined && caps.audio !== 'selectable') {
    return { field: 'audio', value: settings.audio, allowed: [] };
  }

  return null;
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all api/services/request-validation_test.ts
```

Expected: `8 passed | 0 failed`.

- [ ] **Step 5: Write the failing route test**

Create `supabase/functions/api/settings_validation_test.ts`:

```ts
import { assertEquals } from 'jsr:@std/assert';
import { createApp } from './app.ts';
import { FakeDb, TEST_USER, fakeAdapter, testDeps } from './testing/fakes.ts';

const AUTH = { authorization: 'Bearer test-token' };

Deno.test('an unsupported resolution is refused before charge and before dispatch', async () => {
  const provider = fakeAdapter();
  const deps = testDeps({ adapterFor: () => provider.adapter });
  const db = deps.admin as unknown as FakeDb;
  db.tables.subscriptions = [
    { user_id: TEST_USER, plan: 'pro', status: 'active', current_period_end: '2099-01-01T00:00:00Z' },
  ];
  db.tables.models = [{ id: 'flux', enabled: true, min_plan: 'studio' }];
  db.rpcHandlers.fn_charge_and_generate = () => {
    throw new Error('charge must not be reached');
  };
  const app = createApp(deps);

  const res = await app.request('/api/generations', {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({
      op: 'generate',
      familyId: 'flux',
      prompt: 'a cat',
      batch: 1,
      settings: { aspectRatio: '1:1', resolution: '8MP' },
    }),
  });

  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.error.code, 'invalid_settings');
  assertEquals(body.error.message, 'FLUX does not offer resolution 8MP.');
  assertEquals(provider.submits.length, 0);
  assertEquals(db.rpcCalls.filter((r) => r.name === 'fn_charge_and_generate').length, 0);
});
```

- [ ] **Step 6: Run to verify it fails**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all api/settings_validation_test.ts
```

Expected: FAIL — status is 200; the request is charged at the `?? 0.03` fallback price.

- [ ] **Step 7: Wire validation into `POST /generations`**

Add the import to `app.ts`:

```ts
import { validateSettings } from './services/request-validation.ts';
```

Extract catalog-family resolution from the outer `else` into a helper with guard-clause returns. After its unknown-family guard, validate with:

```ts
      const invalid = validateSettings(family, settings);
      if (invalid) return fail(
          c,
          400,
          'invalid_settings',
          `${family.name} does not offer ${invalid.field} ${invalid.value}.`,
        );
```

Validation runs before `creditCost(family, settings)` on the next lines, so a rejected axis can never be priced.

- [ ] **Step 8: Run everything**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno check api/index.ts api/app.ts stripe-webhook/index.ts appstore-webhook/index.ts && deno test --allow-all _shared api
```

Expected: `105 passed | 0 failed` (96 + 8 validation unit + 1 validation route).

- [ ] **Step 9: Run the Angular suite and a production build**

```bash
cd /Users/user/IdeaProjects/vansen && npm test -- --watch=false && export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use 22.23.1 >/dev/null && npx ng build
```

Expected: `242 passed`, 42 files; build succeeds. User commits.

---

## Exit criteria for P1

- [ ] Every gateway route can be exercised with `createApp(testDeps())` and `app.request(...)`; no test opens a socket or touches a real database.
- [ ] `deno test --allow-all _shared api` reports 105 passing; `npm test -- --watch=false` reports 242 passing; `npx ng build` succeeds.
- [ ] A missing OpenAI key, a 503, a timeout, a malformed body, a failed scratch write and a failed signing step all return 503 `moderation_unavailable` with no charge, no dispatch and no strike.
- [ ] A foreign upload path, a quarantine path, an unregistered path, an unmoderated upload and a persona photo are all refused as an image reference, with zero signing, charging or adapter calls.
- [ ] Uploading a reference and generating produces exactly one charge and one adapter call carrying `referenceUrl`, for all four image families.
- [ ] A video poster crosses the same moderation gate as any other user image.
- [ ] An axis value the selected family does not offer returns 400 `invalid_settings` before pricing.
- [ ] `supabase/migrations/0017_upload_registry.sql` exists, is additive, and has NOT been applied to production by this plan.

**Known carry-forward (not P1's job):** `openai.ts` still ignores a reference on `generate` (P3 Task 3); the gateway still has no request idempotency key and still inserts jobs outside the charge transaction (P5); `fn_fail_job` is still an unconditional update (P4); the 24-hour video spend read is still outside the charge lock (P5).
