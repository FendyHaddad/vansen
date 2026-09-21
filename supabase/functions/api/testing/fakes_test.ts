// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals } from "jsr:@std/assert";
import { FakeDb, FakeStorage, TEST_USER } from "./fakes.ts";

Deno.test("select + eq + maybeSingle returns the matching row", async () => {
  const db = new FakeDb();
  db.tables.profiles = [
    { id: TEST_USER, birth_date: "1990-01-01", strikes: 0 },
    { id: "other", birth_date: null, strikes: 0 },
  ];
  const { data, error } = await db.from("profiles").select("birth_date").eq(
    "id",
    TEST_USER,
  ).maybeSingle();
  assertEquals(error, null);
  assertEquals(data, { birth_date: "1990-01-01" });
});

Deno.test("maybeSingle on no match returns null data and no error", async () => {
  const db = new FakeDb();
  db.tables.profiles = [];
  const { data, error } = await db.from("profiles").select("*").eq("id", "nope")
    .maybeSingle();
  assertEquals(data, null);
  assertEquals(error, null);
});

Deno.test("insert returns the inserted row with a generated id", async () => {
  const db = new FakeDb();
  db.tables.jobs = [];
  const { data, error } = await db
    .from("jobs")
    .insert({ generation_id: "g1", user_id: TEST_USER, provider: "fal" })
    .select("id")
    .single();
  assertEquals(error, null);
  assertEquals(typeof (data as { id: string }).id, "string");
  assertEquals(db.tables.jobs.length, 1);
});

Deno.test("insert of a duplicate primary key returns a 23505 error", async () => {
  const db = new FakeDb();
  db.primaryKeys.webhook_events = "id";
  db.tables.webhook_events = [{ id: "evt_1", type: "x" }];
  const { error } = await db.from("webhook_events").insert({
    id: "evt_1",
    type: "x",
  });
  assertEquals(error?.code, "23505");
});

Deno.test("update applies only to filtered rows and reports them", async () => {
  const db = new FakeDb();
  db.tables.generations = [
    { id: "a", status: "pending" },
    { id: "b", status: "pending" },
  ];
  const { data } = await db
    .from("generations")
    .update({ status: "done" })
    .eq("id", "a")
    .eq("status", "pending")
    .select("id");
  assertEquals(data, [{ id: "a" }]);
  assertEquals(db.tables.generations[1].status, "pending");
});

Deno.test("delete removes and returns the row", async () => {
  const db = new FakeDb();
  db.tables.generations = [{
    id: "a",
    user_id: TEST_USER,
    media_path: "p.png",
  }];
  const { data } = await db
    .from("generations")
    .delete()
    .eq("id", "a")
    .eq("user_id", TEST_USER)
    .select("id,media_path")
    .maybeSingle();
  assertEquals(data, { id: "a", media_path: "p.png" });
  assertEquals(db.tables.generations.length, 0);
});

Deno.test("head count returns a count and no rows", async () => {
  const db = new FakeDb();
  db.tables.generations = [
    { id: "a", user_id: TEST_USER, kind: "video", status: "pending" },
    { id: "b", user_id: TEST_USER, kind: "video", status: "pending" },
  ];
  const { count, data } = await db
    .from("generations")
    .select("id", { count: "exact", head: true })
    .eq("user_id", TEST_USER)
    .eq("status", "pending");
  assertEquals(count, 2);
  assertEquals(data, null);
});

Deno.test("order desc then limit", async () => {
  const db = new FakeDb();
  db.tables.generations = [
    { id: "old", created_at: "2026-01-01T00:00:00Z" },
    { id: "new", created_at: "2026-02-01T00:00:00Z" },
  ];
  const { data } = await db
    .from("generations")
    .select("id")
    .order("created_at", { ascending: false })
    .limit(1);
  assertEquals(data, [{ id: "new" }]);
});

Deno.test("failNext injects one error then clears", async () => {
  const db = new FakeDb();
  db.tables.generations = [{ id: "a", status: "pending" }];
  db.failNext("generations.update", "connection lost");
  const first = await db.from("generations").update({ status: "done" }).eq(
    "id",
    "a",
  );
  assertEquals(first.error?.message, "connection lost");
  assertEquals(db.tables.generations[0].status, "pending");
  const second = await db.from("generations").update({ status: "done" }).eq(
    "id",
    "a",
  );
  assertEquals(second.error, null);
  assertEquals(db.tables.generations[0].status, "done");
});

Deno.test("rpc records the call and runs the handler", async () => {
  const db = new FakeDb();
  db.rpcHandlers.fn_balances = () => [{ plan_credits: 100, pack_credits: 5 }];
  const { data, error } = await db.rpc("fn_balances", { p_user: TEST_USER });
  assertEquals(error, null);
  assertEquals(data, [{ plan_credits: 100, pack_credits: 5 }]);
  assertEquals(db.rpcCalls[0].name, "fn_balances");
});

Deno.test("storage upload then signed url round-trips", async () => {
  const storage = new FakeStorage();
  const up = await storage.from("uploads").upload(
    "u/1.png",
    new Uint8Array([1]),
    { contentType: "image/png" },
  );
  assertEquals(up.error, null);
  const { data } = await storage.from("uploads").createSignedUrl(
    "u/1.png",
    600,
  );
  assertEquals(
    data?.signedUrl,
    "https://fake.storage/uploads/u/1.png?token=signed",
  );
});

Deno.test("storage failNext makes the next upload fail and store nothing", async () => {
  const storage = new FakeStorage();
  storage.failNext("uploads.upload", "disk full");
  const { error } = await storage.from("uploads").upload(
    "u/1.png",
    new Uint8Array([1]),
    { contentType: "image/png" },
  );
  assertEquals(error?.message, "disk full");
  assertEquals(storage.objects.size, 0);
});
