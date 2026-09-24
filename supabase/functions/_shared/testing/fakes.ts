// deno-lint-ignore-file require-await
// In-memory stand-ins for the service-role Supabase client and Storage, shared
// by the gateway and the webhook functions. Only the surface they actually use
// — this is a test double, not a Postgres emulator. Filters are applied in
// insertion order; ordering is a plain string/number compare, which is enough
// for the ISO timestamps and uuids these functions sort on.
import { PERSONA_SLOT_ORDER, PERSONA_SLOTS } from "../model-families.ts";

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

/** Splits on commas that are not inside parentheses. */
function splitTerms(expression: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < expression.length; i += 1) {
    const ch = expression[i];
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch !== "," || depth !== 0) continue;
    out.push(expression.slice(start, i));
    start = i + 1;
  }
  out.push(expression.slice(start));
  return out.filter((t) => t.length > 0);
}

function parseOrTerm(term: string): (r: Row) => boolean {
  if (term.startsWith("and(") && term.endsWith(")")) {
    const inner = splitTerms(term.slice(4, -1)).map(parseOrTerm);
    return (r) => inner.every((f) => f(r));
  }
  const first = term.indexOf(".");
  const second = term.indexOf(".", first + 1);
  if (first < 0 || second < 0) throw new Error(`fake or(${term}) is malformed`);
  const col = term.slice(0, first);
  const op = term.slice(first + 1, second);
  const val = term.slice(second + 1);
  if (op === "eq") return (r) => String(r[col] ?? "") === val;
  if (op === "lt") return (r) => compare(r[col], val) < 0;
  if (op === "gt") return (r) => compare(r[col], val) > 0;
  throw new Error(`fake or(${op}) is not implemented`);
}

class FakeQuery implements PromiseLike<FakeResult<unknown>> {
  private filters: ((r: Row) => boolean)[] = [];
  private cols?: string;
  private sorts: { col: string; asc: boolean }[] = [];
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

  /** PostgREST's negated filter. Only `is` is used against this fake. */
  not(col: string, op: string, val: unknown): this {
    if (op !== "is") throw new Error(`fake not(${op}) is not implemented`);
    this.filters.push((r) => (r[col] ?? null) !== val);
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

  /** Chained calls are secondary keys, as PostgREST orders them. */
  order(col: string, opts?: { ascending?: boolean }): this {
    this.sorts.push({ col, asc: opts?.ascending !== false });
    return this;
  }

  /**
   * PostgREST's disjunction, in the one shape the gateway builds: top-level
   * terms separated by commas, each either `col.op.value` or `and(...)` of
   * such terms. Anything else throws rather than silently matching nothing.
   */
  or(expression: string): this {
    const terms = splitTerms(expression).map(parseOrTerm);
    this.filters.push((r) => terms.some((t) => t(r)));
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
    if (this.sorts.length > 0) {
      out = [...out].sort((a, b) => {
        for (const { col, asc } of this.sorts) {
          const c = asc ? compare(a[col], b[col]) : compare(b[col], a[col]);
          if (c !== 0) return c;
        }
        return 0;
      });
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
  /** Observer for tests that care about the ORDER of writes. */
  onUpload?: (bucket: string, path: string) => void;
  /** Observer for tests that count signing round trips. */
  onSign?: (bucket: string, path: string) => void;
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
    const observe = this.onUpload;
    const observeSign = this.onSign;
    return {
      // deno-lint-ignore no-explicit-any
      async upload(path: string, bytes: Uint8Array, opts?: any) {
        const fail = take("upload");
        if (fail) return { data: null, error: fail };
        observe?.(bucket, path);
        objects.set(`${bucket}/${path}`, {
          bytes,
          contentType: opts?.contentType ?? "application/octet-stream",
        });
        return { data: { path }, error: null };
      },
      async createSignedUrl(path: string, _ttl: number) {
        observeSign?.(bucket, path);
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
      /** Batch form of `createSignedUrl`: one round trip for many paths. */
      async createSignedUrls(paths: string[], _ttl: number) {
        const fail = take("createSignedUrls");
        if (fail) return { data: null, error: fail };
        const data = paths.map((path) => {
          observeSign?.(bucket, path);
          if (!objects.has(`${bucket}/${path}`)) {
            return { path, signedUrl: null, error: "Object not found" };
          }
          return {
            path,
            signedUrl: `https://fake.storage/${bucket}/${path}?token=signed`,
            error: null,
          };
        });
        return { data, error: null };
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
      // Mirrors supabase-storage's listing: `search` is a substring filter
      // inside one prefix, and a failure is an error, never an empty page.
      async list(prefix: string, opts?: { search?: string; limit?: number }) {
        const fail = take("list");
        if (fail) return { data: null, error: fail };
        const head = prefix ? `${bucket}/${prefix}/` : `${bucket}/`;
        const names: { name: string }[] = [];
        for (const key of objects.keys()) {
          if (!key.startsWith(head)) continue;
          const rest = key.slice(head.length);
          if (rest.includes("/")) continue;
          if (opts?.search && !rest.includes(opts.search)) continue;
          names.push({ name: rest });
        }
        return { data: names.slice(0, opts?.limit ?? 100), error: null };
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


/**
 * The object registry and deletion outbox of 0021, reduced to what the
 * gateway and the cleanup worker actually read back. The real behaviour —
 * bucket-aware locators, leases, holds, dead letters — is proven in
 * supabase/tests/deletion.sql; this exists so route tests can register and
 * queue objects without a database.
 */
export function installRegistryRpcs(db: FakeDb): void {
  db.tables.storage_objects ??= [];
  db.tables.deletion_outbox ??= [];
  db.tables.storage_config ??= [{ key: "r2_bucket", value: "vansen-test" }];

  db.rpcHandlers.fn_storage_config = (args, self) => {
    const row = (self.tables.storage_config ?? []).find((r) =>
      r.key === args.p_key
    );
    if (!row) throw new Error(`storage_config ${args.p_key} is not set`);
    return row.value;
  };
  db.rpcHandlers.fn_register_object = (args, self) => {
    self.tables.storage_objects ??= [];
    const found = self.tables.storage_objects.find((o) =>
      o.backend === args.p_backend && o.bucket === args.p_bucket &&
      o.path === args.p_path
    );
    if (found) return found.id;
    const id = `obj-${self.tables.storage_objects.length + 1}`;
    self.tables.storage_objects.push({
      id,
      user_id: args.p_user,
      backend: args.p_backend,
      bucket: args.p_bucket,
      path: args.p_path,
      purpose: args.p_purpose,
      state: "staged",
      retain_until: null,
    });
    return id;
  };
  db.rpcHandlers.fn_mark_object_live = (args, self) => {
    const row = (self.tables.storage_objects ?? []).find((o) =>
      o.id === args.p_id
    );
    if (!row || row.state === "gone") return false;
    if (row.state === "staged" || row.state === "live") row.state = "live";
    return true;
  };
  db.rpcHandlers.fn_hold_object = (args, self) => {
    const row = (self.tables.storage_objects ?? []).find((o) =>
      o.id === args.p_id
    );
    if (!row) return false;
    row.state = "held";
    row.retain_until = args.p_until;
    return true;
  };
  db.rpcHandlers.fn_enqueue_deletions = (args, self) => {
    self.tables.deletion_outbox ??= [];
    const ids = (args.p_objects as string[]) ?? [];
    let queued = 0;
    for (const id of ids) {
      const row = (self.tables.storage_objects ?? []).find((o) => o.id === id);
      if (!row) continue;
      if (row.state === "gone") continue;
      // Evidence under an unexpired hold is never queued.
      if (
        row.state === "held" &&
        new Date(String(row.retain_until ?? 0)).getTime() > Date.now()
      ) {
        continue;
      }
      row.state = "delete_pending";
      const already = self.tables.deletion_outbox.find((d) =>
        d.object_id === id && d.completed_at == null
      );
      if (already) continue;
      self.tables.deletion_outbox.push({
        id: `del-${self.tables.deletion_outbox.length + 1}`,
        object_id: id,
        backend: row.backend,
        bucket: row.bucket,
        object_path: row.path,
        reason: args.p_reason,
        attempts: 0,
        lease_token: null,
        completed_at: null,
      });
      queued += 1;
    }
    return queued;
  };

  // The content lifecycle the gateway calls. Mirrors the CONTRACT proven in
  // supabase/tests/deletion.sql: ownership decides not_found, a live job
  // holds the row back, and a repeat is idempotent rather than a second
  // queueing.
  const reap = (
    self: FakeDb,
    table: "generations" | "personas",
    id: string,
    reason: string,
  ) => {
    // Personas have no job of their own any more (0032 dropped training_jobs):
    // a persona's only work in flight is a generation that references it, and
    // that generation is not this row, so nothing here blocks a persona reap.
    const jobs = table === "generations"
      ? (self.tables.jobs ?? []).filter((j) =>
        j.generation_id === id && j.state !== "done"
      )
      : [];
    if (jobs.length > 0) return { status: "pending_job", objects: 0 };
    const row = (self.tables[table] ?? []).find((r) => r.id === id);
    const paths = table === "generations"
      ? [row?.media_path, row?.thumb_path]
      : Object.values((row?.photos as Record<string, string | null>) ?? {});
    const ids: string[] = [];
    for (const path of paths) {
      if (!path) continue;
      const object = (self.tables.storage_objects ?? []).find((o) =>
        o.path === path
      );
      if (object) ids.push(String(object.id));
    }
    const queued = self.rpcHandlers.fn_enqueue_deletions(
      { p_objects: ids, p_reason: reason },
      self,
    ) as number;
    self.tables[table] = (self.tables[table] ?? []).filter((r) => r.id !== id);
    return { status: "queued", objects: queued };
  };

  db.rpcHandlers.fn_delete_generation = (args, self) => {
    const row = (self.tables.generations ?? []).find((r) =>
      r.id === args.p_id && r.user_id === args.p_user
    );
    if (!row) throw new Error("not_found");
    row.deleted_at ??= self.now().toISOString();
    for (const job of self.tables.jobs ?? []) {
      if (job.generation_id !== row.id || job.state === "done") continue;
      job.cancel_requested_at ??= self.now().toISOString();
    }
    return reap(self, "generations", String(row.id), "generation_deleted");
  };
  db.rpcHandlers.fn_delete_persona = (args, self) => {
    const row = (self.tables.personas ?? []).find((r) =>
      r.id === args.p_id && r.user_id === args.p_user
    );
    if (!row) throw new Error("not_found");
    row.deleted_at ??= self.now().toISOString();
    // Nothing is trained and no provider holds a file for us any more (0032):
    // a persona's only objects are its own photos, which `reap` queues.
    return reap(self, "personas", String(row.id), "persona_deleted");
  };
  const emptyPersonaPhotos = () =>
    Object.fromEntries(PERSONA_SLOT_ORDER.map((slot) => [slot, null])) as Record<
      string,
      string | null
    >;

  /** The locked slot check `caps_concurrency.sh` proves: idempotent by
   * (user, key), a hash mismatch on a reused key is a conflict, and the plan's
   * subscription decides the cap — read the same way `activePlan` does. */
  db.rpcHandlers.fn_reserve_persona = (args, self) => {
    self.tables.submissions ??= [];
    const key = String(args.p_key);
    const existing = self.tables.submissions.find((r) =>
      r.user_id === args.p_user && r.idempotency_key === key
    );
    if (existing && existing.body_hash !== args.p_hash) {
      throw new Error("idempotency_conflict");
    }
    if (existing) return existing.result;

    // The gateway's `isEntitled` rule exactly (0037): anything but expired; a
    // canceled plan until its paid period ends; an active plan until 3 days
    // after it.
    const nowMs = self.now().getTime();
    const endMs = (s: Row) =>
      s.current_period_end ? new Date(String(s.current_period_end)).getTime() : null;
    const lapsed = (s: Row) => {
      const end = endMs(s);
      if (end === null) return false;
      if (s.status === "canceled") return end < nowMs;
      return end <= nowMs - 3 * 86_400_000;
    };
    const sub = (self.tables.subscriptions ?? []).find((s) =>
      s.user_id === args.p_user && s.status !== "expired" && !lapsed(s)
    );
    if (!sub) throw new Error("subscription_required");

    const limit = PERSONA_SLOTS[sub.plan as keyof typeof PERSONA_SLOTS] ?? 0;
    self.tables.personas ??= [];
    const live = self.tables.personas.filter((p) =>
      p.user_id === args.p_user && !p.deleted_at &&
      (p.status === "draft" || p.status === "ready")
    ).length;
    if (live >= limit) throw new Error("slot_limit");

    const id = `pppppppp-0000-4000-8000-${
      String(self.tables.personas.length + 1).padStart(12, "0")
    }`;
    self.tables.personas.push({
      id,
      user_id: args.p_user,
      name: args.p_name,
      status: "draft",
      photos: emptyPersonaPhotos(),
      consent_attested_at: self.now().toISOString(),
      created_at: self.now().toISOString(),
      deleted_at: null,
    });
    const result = { personaId: id };
    self.tables.submissions.push({
      user_id: args.p_user,
      idempotency_key: key,
      body_hash: args.p_hash,
      result,
    });
    return result;
  };
  /** Mirrors `fn_set_persona_photo` (0032): the slot must be one of the five,
   * the upload must still be this user's own moderated persona-photo, no
   * OTHER persona of theirs may already hold it, and a photo it replaces is
   * queued for deletion exactly like any other object the registry drops. */
  db.rpcHandlers.fn_set_persona_photo = (args, self) => {
    const slot = String(args.p_slot);
    if (!(PERSONA_SLOT_ORDER as readonly string[]).includes(slot)) {
      throw new Error("invalid_slot");
    }
    const path = String(args.p_path);
    const upload = (self.tables.uploads ?? []).find((u) =>
      u.path === path && u.user_id === args.p_user
    );
    const usable = !!upload && upload.purpose === "persona-photo" &&
      upload.moderation === "allowed";
    if (!usable) throw new Error("invalid_photo");
    const heldByAnother = (self.tables.personas ?? []).some((p) =>
      p.user_id === args.p_user && p.id !== args.p_persona &&
      Object.values((p.photos as Record<string, string | null>) ?? {}).includes(path)
    );
    if (heldByAnother) throw new Error("invalid_photo");

    const row = (self.tables.personas ?? []).find((r) =>
      r.id === args.p_persona && r.user_id === args.p_user && !r.deleted_at
    );
    if (!row) throw new Error("not_found");
    const photos = { ...(row.photos as Record<string, string | null>) };
    const old = photos[slot];
    photos[slot] = path;
    row.photos = photos;
    row.status = Object.values(photos).every((p) => p) ? "ready" : "draft";

    // A photo no other slot still holds is queued for deletion, the same way
    // `reap` queues a persona's photos when the persona itself is deleted.
    const replaced = !!old && old !== path;
    const stillHeld = replaced && Object.values(photos).includes(old as string);
    if (replaced && !stillHeld) {
      const object = (self.tables.storage_objects ?? []).find((o) => o.path === old);
      if (object) {
        self.rpcHandlers.fn_enqueue_deletions(
          { p_objects: [String(object.id)], p_reason: "persona_photo_replaced" },
          self,
        );
      }
    }
    return { status: row.status, replaced };
  };

  // Account closure, as the gateway sees it: one open request per user, work
  // that is still running holds the data back, and the auth user is only
  // named once the data side is finalised.
  db.rpcHandlers.fn_delete_account = (args, self) => {
    self.tables.account_deletions ??= [];
    const user = String(args.p_user);
    let request = self.tables.account_deletions.find((r) =>
      r.user_id === user || r.closed_user_id === user
    );
    if (!request) {
      request = {
        id: crypto.randomUUID(),
        user_id: user,
        closed_user_id: user,
        auth_user_id: user,
        status: "processing",
        subscriptions: args.p_subscriptions ?? [],
        data_finalized_at: null,
      };
      self.tables.account_deletions.push(request);
    }
    request.subscriptions = args.p_subscriptions ?? request.subscriptions;

    for (const row of self.tables.generations ?? []) {
      if (row.user_id !== user) continue;
      row.deleted_at ??= self.now().toISOString();
    }
    for (const row of self.tables.personas ?? []) {
      if (row.user_id !== user) continue;
      row.deleted_at ??= self.now().toISOString();
    }
    const live = (self.tables.jobs ?? []).filter((j) =>
      j.user_id === user && j.state !== "done"
    ).length;
    for (const job of self.tables.jobs ?? []) {
      if (job.user_id !== user || job.state === "done") continue;
      job.cancel_requested_at ??= self.now().toISOString();
    }
    const artifacts = (self.tables.provider_artifact_deletions ?? []).filter(
      (a) => a.user_id === user && a.status === "requested",
    ).length;
    if (live > 0) {
      return {
        status: "processing",
        requestId: request.id,
        pendingJobs: live,
        providerArtifacts: artifacts,
      };
    }
    request.data_finalized_at = self.now().toISOString();
    request.user_id = null;
    self.tables.profiles = (self.tables.profiles ?? []).filter((r) =>
      r.id !== user
    );
    return {
      status: "processing",
      requestId: request.id,
      authUserId: user,
      pendingJobs: 0,
      providerArtifacts: artifacts,
    };
  };
  db.rpcHandlers.fn_complete_account_deletion = (args, self) => {
    const request = (self.tables.account_deletions ?? []).find((r) =>
      r.id === args.p_request
    );
    if (!request) return { status: "processing", reason: "not_found" };
    const user = String(request.closed_user_id ?? "");
    const unresolved = (self.tables.provider_artifact_deletions ?? []).filter(
      (a) => a.user_id === user && a.status === "requested",
    ).length;
    if (unresolved > 0) {
      return { status: "processing", reason: "provider_artifacts_unresolved" };
    }
    request.status = "completed";
    request.auth_user_id = null;
    return { status: "completed", requestId: request.id };
  };

  // The claim/acknowledge pair the cleanup worker fences against. The real
  // functions are proven in supabase/tests/deletion.sql; this mirrors their
  // CONTRACT — a lease token, and a zero-row acknowledgement that is a stale
  // claim rather than a success.
  db.rpcHandlers.fn_claim_deletions = (args, self) => {
    self.tables.deletion_outbox ??= [];
    const now = self.now().getTime();
    const due = self.tables.deletion_outbox.filter((d) =>
      d.completed_at == null &&
      new Date(String(d.not_before ?? 0)).getTime() <= now &&
      (d.lease_until == null ||
        new Date(String(d.lease_until)).getTime() < now)
    ).slice(0, Number(args.p_limit ?? 25));
    for (const row of due) {
      row.attempts = Number(row.attempts ?? 0) + 1;
      row.lease_token = `lease-${row.id}-${row.attempts}`;
      row.lease_until = new Date(now + 120_000).toISOString();
    }
    return due.map((r) => ({ ...r }));
  };
  db.rpcHandlers.fn_complete_deletion = (args, self) => {
    const now = self.now().getTime();
    const row = (self.tables.deletion_outbox ?? []).find((d) =>
      d.id === args.p_id && d.lease_token === args.p_token &&
      d.completed_at == null &&
      new Date(String(d.lease_until ?? 0)).getTime() > now
    );
    if (!row) return { acknowledged: false, reason: "stale_or_done" };
    if (args.p_error == null) {
      row.completed_at = new Date(now).toISOString();
      row.lease_token = null;
      row.lease_until = null;
      const object = (self.tables.storage_objects ?? []).find((o) =>
        o.id === row.object_id
      );
      if (object) object.state = "gone";
      return { acknowledged: true, state: "gone" };
    }
    const attempts = Number(row.attempts ?? 0);
    row.lease_token = null;
    row.lease_until = null;
    row.last_error = String(args.p_error).slice(0, 500);
    row.not_before = new Date(
      now + Math.min(3600, 60 * 2 ** Math.min(attempts, 6)) * 1000,
    ).toISOString();
    const budget = Number(
      (self.tables.dispatch_limits ?? []).find((l) =>
        l.key === "deletion_max_attempts"
      )?.value ?? 12,
    );
    if (attempts >= budget) {
      return { acknowledged: true, state: "dead_letter", attempts };
    }
    return { acknowledged: true, state: "retry", attempts };
  };
}
