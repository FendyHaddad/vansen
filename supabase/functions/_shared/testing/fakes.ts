// deno-lint-ignore-file require-await
// In-memory stand-ins for the service-role Supabase client and Storage, shared
// by the gateway and the webhook functions. Only the surface they actually use
// — this is a test double, not a Postgres emulator. Filters are applied in
// insertion order; ordering is a plain string/number compare, which is enough
// for the ISO timestamps and uuids these functions sort on.

export type Row = Record<string, unknown>;
export interface FakeError {
  message: string;
  code?: string;
}
export interface FakeResult<T> {
  data: T;
  error: FakeError | null;
  count?: number | null;
}

export const TEST_USER = "11111111-1111-4111-8111-111111111111";
export const OTHER_USER = "22222222-2222-4222-8222-222222222222";

type Op = "select" | "insert" | "update" | "delete" | "upsert";

function project(row: Row, cols: string | undefined): Row {
  if (!cols || cols.trim() === "*") return { ...row };
  const names = cols.split(",").map((c) => c.trim()).filter((c) =>
    c && c !== "*"
  );
  if (names.length === 0) return { ...row };
  const out: Row = {};
  for (const name of names) out[name] = row[name];
  return out;
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a ?? "").localeCompare(String(b ?? ""));
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

  select(cols?: string, opts?: { count?: "exact"; head?: boolean }): this {
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
      return {
        data: null,
        error: {
          message: "JSON object requested, multiple (or no) rows returned",
          code: "PGRST116",
        },
      };
    }
    return { data: rows[0], error: null };
  }

  async maybeSingle(): Promise<FakeResult<Row | null>> {
    const res = await this.run();
    if (res.error) return { data: null, error: res.error };
    const rows = (res.data ?? []) as Row[];
    if (rows.length > 1) {
      return {
        data: null,
        error: { message: "multiple rows returned", code: "PGRST116" },
      };
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
    if (injected) {
      return Promise.resolve({ data: null, error: injected, count: null });
    }
    if (this.op === "select") return Promise.resolve(this.runSelect());
    if (this.op === "insert") return Promise.resolve(this.runInsert());
    if (this.op === "upsert") return Promise.resolve(this.runUpsert());
    if (this.op === "update") return Promise.resolve(this.runUpdate());
    return Promise.resolve(this.runDelete());
  }

  private runSelect(): FakeResult<unknown> {
    let out = this.matched();
    if (this.sort) {
      const { col, asc } = this.sort;
      out = [...out].sort((
        a,
        b,
      ) => (asc ? compare(a[col], b[col]) : compare(b[col], a[col])));
    }
    const count = out.length;
    if (this.max != null) out = out.slice(0, this.max);
    if (this.headOnly) return { data: null, error: null, count };
    return {
      data: out.map((r) => project(r, this.cols)),
      error: null,
      count: this.wantCount ? count : null,
    };
  }

  private runInsert(): FakeResult<unknown> {
    const incoming = Array.isArray(this.payload)
      ? this.payload
      : [this.payload as Row];
    const pk = this.db.primaryKeys[this.table];
    const written: Row[] = [];
    for (const item of incoming) {
      if (pk && this.rows().some((r) => r[pk] === item[pk])) {
        return {
          data: null,
          error: {
            message:
              `duplicate key value violates unique constraint "${this.table}_pkey"`,
            code: "23505",
          },
        };
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
    const incoming = Array.isArray(this.payload)
      ? this.payload
      : [this.payload as Row];
    const keys = (this.onConflict ?? "id").split(",").map((k) => k.trim());
    for (const item of incoming) {
      const hit = this.rows().find((r) => keys.every((k) => r[k] === item[k]));
      if (hit) Object.assign(hit, item);
      if (!hit) {
        this.rows().push({
          id: crypto.randomUUID(),
          created_at: this.db.now().toISOString(),
          ...item,
        });
      }
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

export interface StoredObject {
  bytes: Uint8Array;
  contentType: string;
}

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
        const fail = take("upload");
        if (fail) return { data: null, error: fail };
        objects.set(`${bucket}/${path}`, {
          bytes,
          contentType: opts?.contentType ?? "application/octet-stream",
        });
        return { data: { path }, error: null };
      },
      async createSignedUrl(path: string, _ttl: number) {
        const fail = take("createSignedUrl");
        if (fail) return { data: null, error: fail };
        if (!objects.has(`${bucket}/${path}`)) {
          return { data: null, error: { message: "Object not found" } };
        }
        return {
          data: {
            signedUrl: `https://fake.storage/${bucket}/${path}?token=signed`,
          },
          error: null,
        };
      },
      async copy(from: string, to: string) {
        const fail = take("copy");
        if (fail) return { data: null, error: fail };
        const hit = objects.get(`${bucket}/${from}`);
        if (!hit) return { data: null, error: { message: "Object not found" } };
        objects.set(`${bucket}/${to}`, hit);
        return { data: { path: to }, error: null };
      },
      async remove(paths: string[]) {
        const fail = take("remove");
        if (fail) return { data: null, error: fail };
        for (const p of paths) objects.delete(`${bucket}/${p}`);
        return { data: null, error: null };
      },
      async download(path: string) {
        const fail = take("download");
        if (fail) return { data: null, error: fail };
        const hit = objects.get(`${bucket}/${path}`);
        if (!hit) return { data: null, error: { message: "Object not found" } };
        return {
          data: new Blob([hit.bytes as BlobPart], { type: hit.contentType }),
          error: null,
        };
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
  private clock = new Date("2026-09-20T00:00:00.000Z");

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
      select: (cols?: string, opts?: { count?: "exact"; head?: boolean }) =>
        new FakeQuery(this, table, "select").select(cols, opts),
      insert: (payload: Row | Row[]) =>
        new FakeQuery(this, table, "insert", payload),
      upsert: (payload: Row | Row[], opts?: { onConflict?: string }) =>
        new FakeQuery(this, table, "upsert", payload, opts?.onConflict),
      update: (payload: Row) => new FakeQuery(this, table, "update", payload),
      delete: () => new FakeQuery(this, table, "delete"),
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
      return {
        data: null,
        error: { message: e instanceof Error ? e.message : String(e) },
      };
    }
  }

  auth = {
    getUser: (token: string) => {
      const user = this.tokens.get(token);
      if (!user) {
        return Promise.resolve({
          data: { user: null },
          error: { message: "invalid token" },
        });
      }
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

