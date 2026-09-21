// R16: the ledger pages by the same keyset cursor as the library.
//
// `.limit(100)` silently truncated the money history: an account with more
// than a hundred entries could not see its own older charges at all.
import { assert, assertEquals } from "jsr:@std/assert";
import { createApp } from "./app.ts";
import { FakeDb, TEST_USER, testDeps } from "./testing/fakes.ts";

const AUTH = { authorization: "Bearer test-token" };

/** `n` entries, newest first, with four sharing one timestamp. */
function entries(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `l${String(i).padStart(4, "0")}`,
    user_id: TEST_USER,
    type: "spend",
    amount_credits: -40,
    bucket: "plan",
    family_id: "flux",
    note: null,
    // Ties are the normal case: a batch writes several entries in one second.
    created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, Math.floor(i / 4)))
      .toISOString(),
  })).reverse();
}

function ledger(n: number) {
  const deps = testDeps();
  const db = deps.admin as unknown as FakeDb;
  db.tables.ledger_entries = entries(n);
  return { deps, db, app: createApp(deps) };
}

async function walk(
  app: ReturnType<typeof createApp>,
  limit: number,
  onPage?: (page: number) => void,
): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 50; page += 1) {
    const url: string = cursor
      ? `/api/ledger?limit=${limit}&cursor=${encodeURIComponent(cursor)}`
      : `/api/ledger?limit=${limit}`;
    const body: { entries: { id: string }[]; nextCursor: string | null } =
      await (await app.request(url, { headers: AUTH })).json();
    seen.push(...body.entries.map((e) => e.id));
    onPage?.(page);
    cursor = body.nextCursor ?? null;
    if (!cursor) break;
  }
  return seen;
}

Deno.test("R16: every entry is reachable exactly once, past the old 100 cap", async () => {
  const { app } = ledger(500);
  const seen = await walk(app, 50);
  assertEquals(seen.length, 500);
  assertEquals(new Set(seen).size, 500, "no entry may appear twice");
});

Deno.test("R16: a newer entry written mid-walk does not shift older pages", async () => {
  const { app, db } = ledger(200);
  const seen = await walk(app, 50, (page) => {
    if (page !== 0) return;
    // A top-up lands between page one and page two. Offset paging would push
    // every remaining row down by one and drop an entry off the seam.
    db.tables.ledger_entries.unshift({
      id: "l-new",
      user_id: TEST_USER,
      type: "topup",
      amount_credits: 1000,
      bucket: "pack",
      family_id: null,
      note: null,
      created_at: "2026-06-01T00:00:00.000Z",
    });
  });

  const original = entries(200).map((e) => e.id);
  for (const id of original) {
    assert(seen.includes(id), `entry ${id} was skipped`);
  }
  assertEquals(new Set(seen).size, seen.length, "no entry may appear twice");
});

Deno.test("R16: an entry deleted mid-walk does not strand the rest", async () => {
  const { app, db } = ledger(200);
  const seen = await walk(app, 50, (page) => {
    if (page !== 0) return;
    const target = db.tables.ledger_entries.findIndex((e) => e.id === "l0000");
    db.tables.ledger_entries.splice(target, 1);
  });
  assert(seen.length >= 199, `only reached ${seen.length} entries`);
  assertEquals(new Set(seen).size, seen.length);
});

Deno.test("R16: the ledger clamps its page size", async () => {
  const { app } = ledger(400);
  const body = await (await app.request("/api/ledger?limit=100000", {
    headers: AUTH,
  })).json();
  assert(body.entries.length <= 100, `returned ${body.entries.length}`);
});

Deno.test("R16: a malformed ledger cursor is a 400", async () => {
  const { app } = ledger(10);
  const res = await app.request("/api/ledger?cursor=%%%", { headers: AUTH });
  assertEquals(res.status, 400);
});

Deno.test("R16: another account's entries never appear", async () => {
  const { app, db } = ledger(10);
  db.tables.ledger_entries[0].user_id = "22222222-2222-4222-8222-222222222222";
  const seen = await walk(app, 50);
  assertEquals(seen.length, 9);
});
