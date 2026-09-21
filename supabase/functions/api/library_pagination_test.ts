// R16/R17: the library is paged by keyset cursor and signs one URL per row.
//
// The old route returned up to 200 rows and signed both the media path and the
// thumbnail for every one of them. That is the largest single request the
// gateway makes and the largest single egress line the product has.
import { assert, assertEquals } from "jsr:@std/assert";
import { createApp } from "./app.ts";
import { FakeDb, TEST_USER, testDeps } from "./testing/fakes.ts";

const AUTH = { authorization: "Bearer test-token" };

/** `n` finished images, newest first, with both objects present in storage. */
function rows(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `g${String(i).padStart(4, "0")}`,
    user_id: TEST_USER,
    kind: "image",
    family_id: "flux",
    family_name: "FLUX",
    op: "generate",
    prompt: "a cat",
    settings: {},
    price_credits: 40,
    status: "done",
    media_path: `u/${i}.png`,
    thumb_path: `u/${i}.thumb.jpg`,
    storage_backend: "supabase",
    deleted_at: null,
    created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
  })).reverse();
}

/** A library of `n` rows whose media actually exists, so signing succeeds. */
function library(n: number) {
  const deps = testDeps();
  const db = deps.admin as unknown as FakeDb;
  db.tables.generations = rows(n);
  for (const row of db.tables.generations) {
    for (const path of [row.media_path, row.thumb_path]) {
      db.storage.objects.set(`media/${path}`, {
        bytes: new Uint8Array([1]),
        contentType: "image/png",
      });
    }
  }
  return { deps, db, app: createApp(deps) };
}

Deno.test("R16: a page is bounded and carries a cursor", async () => {
  const { app } = library(120);

  const res = await app.request("/api/generations?limit=50", { headers: AUTH });
  const body = await res.json();

  assertEquals(body.items.length, 50);
  assert(
    typeof body.nextCursor === "string" && body.nextCursor.length > 0,
    `no cursor: ${JSON.stringify(body.nextCursor)}`,
  );
});

Deno.test("R16: the cursor walks the library without gaps or repeats", async () => {
  const { app } = library(120);

  const seen: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 10; page += 1) {
    const url: string = cursor
      ? `/api/generations?limit=50&cursor=${encodeURIComponent(cursor)}`
      : "/api/generations?limit=50";
    const body: { items: { id: string }[]; nextCursor: string | null } =
      await (await app.request(url, { headers: AUTH })).json();
    seen.push(...body.items.map((i: { id: string }) => i.id));
    cursor = body.nextCursor ?? null;
    if (!cursor) break;
  }

  assertEquals(seen.length, 120);
  assertEquals(new Set(seen).size, 120, "no id may appear twice");
});

Deno.test("R16: rows sharing a timestamp still page exactly once", async () => {
  const { app, db } = library(60);
  // Batches of four share a second, so with a page of ten every second seam
  // lands inside a tie. Ordering on created_at alone either skips the rest of
  // a batch or hands one of it out twice.
  db.tables.generations.forEach((row, i) => {
    row.created_at = new Date(Date.UTC(2026, 0, 1, 0, 0, Math.floor(i / 4)))
      .toISOString();
  });

  const seen: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20; page += 1) {
    const url: string = cursor
      ? `/api/generations?limit=10&cursor=${encodeURIComponent(cursor)}`
      : "/api/generations?limit=10";
    const body: { items: { id: string }[]; nextCursor: string | null } =
      await (await app.request(url, { headers: AUTH })).json();
    seen.push(...body.items.map((i: { id: string }) => i.id));
    cursor = body.nextCursor ?? null;
    if (!cursor) break;
  }

  assertEquals(new Set(seen).size, 60);
});

Deno.test("R16: the last page reports no cursor", async () => {
  const { app } = library(10);
  const body = await (await app.request("/api/generations?limit=50", {
    headers: AUTH,
  })).json();
  assertEquals(body.nextCursor, null);
});

Deno.test("R16: an absurd limit is clamped, not honoured", async () => {
  const { app } = library(500);
  const body = await (await app.request("/api/generations?limit=100000", {
    headers: AUTH,
  })).json();
  assert(body.items.length <= 100, `returned ${body.items.length}`);
});

Deno.test("R16: a malformed cursor is a 400, not a full-table scan", async () => {
  const { app } = library(10);
  const res = await app.request("/api/generations?cursor=not-a-cursor", {
    headers: AUTH,
  });
  assertEquals(res.status, 400);
});

Deno.test("R16: a cursor cannot smuggle a filter into the query", async () => {
  const { app } = library(10);
  const hostile = btoa("2026-01-01T00:00:00.000Z|g0000),or(user_id.neq.x");
  const res = await app.request(
    `/api/generations?cursor=${encodeURIComponent(hostile)}`,
    { headers: AUTH },
  );
  assertEquals(res.status, 400);
});

Deno.test("R17: a page signs at most one URL per row", async () => {
  const { app, db } = library(50);
  let signCalls = 0;
  db.storage.onSign = () => {
    signCalls += 1;
  };

  await app.request("/api/generations?limit=50", { headers: AUTH });

  // The grid needs thumbnails. Full media is signed on demand, when an item
  // is actually opened — signing both for every row doubled the round trips.
  assertEquals(signCalls, 50);
});

Deno.test("R17: opening one item signs its full media", async () => {
  const { app } = library(3);
  const res = await app.request("/api/generations/g0002", { headers: AUTH });
  assertEquals(res.status, 200);
  const body = await res.json();
  assert(
    typeof body.item.mediaUrl === "string" && body.item.mediaUrl.length > 0,
    "the opened item has no media url",
  );
});

Deno.test("R17: another account's item is a 404, not a signed URL", async () => {
  const { app, db } = library(3);
  db.tables.generations[0].user_id = "22222222-2222-4222-8222-222222222222";
  const res = await app.request(`/api/generations/${db.tables.generations[0].id}`, {
    headers: AUTH,
  });
  assertEquals(res.status, 404);
});

Deno.test("R16: an old item's version chain is reachable off-page", async () => {
  const { app, db } = library(120);
  // The edit chain hangs off the very oldest row, far past the first page.
  const root = db.tables.generations[119];
  db.tables.generations.unshift({
    ...root,
    id: "edit-1",
    parent_id: root.id,
    op: "edit",
    created_at: "2026-02-01T00:00:00.000Z",
  });

  const body = await (await app.request(`/api/generations/${root.id}/versions`, {
    headers: AUTH,
  })).json();

  assertEquals(body.items.map((i: { id: string }) => i.id), [
    root.id,
    "edit-1",
  ]);
  assertEquals(body.nextCursor, null);
});

Deno.test("R17: a row with no thumbnail still gets exactly one URL", async () => {
  const { app, db } = library(3);
  // A video whose poster has not been captured, and a pre-0022 image.
  for (const row of db.tables.generations) row.thumb_path = null;
  let signCalls = 0;
  db.storage.onSign = () => {
    signCalls += 1;
  };

  const body = await (await app.request("/api/generations?limit=50", {
    headers: AUTH,
  })).json();

  assertEquals(signCalls, 3);
  // The tile falls back to the original, and the poster capture has a source.
  assert(body.items.every((i: { mediaUrl: string }) => i.mediaUrl.length > 0));
  assertEquals(body.items[0].thumbUrl, undefined);
});
