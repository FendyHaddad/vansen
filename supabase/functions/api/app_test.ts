// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals } from "jsr:@std/assert";
import { createApp } from "./app.ts";
import { OTHER_USER, TEST_USER, testDeps } from "./testing/fakes.ts";

const AUTH = { authorization: "Bearer test-token" };

Deno.test("no token → 401", async () => {
  const app = createApp(testDeps());
  const res = await app.request("/api/profile");
  assertEquals(res.status, 401);
  assertEquals((await res.json()).error.code, "unauthorized");
});

Deno.test("unknown token → 401", async () => {
  const app = createApp(testDeps());
  const res = await app.request("/api/profile", {
    headers: { authorization: "Bearer nope" },
  });
  assertEquals(res.status, 401);
});

Deno.test("age-unconfirmed user → 403 on a protected route", async () => {
  const deps = testDeps();
  const db = deps.admin as unknown as import("./testing/fakes.ts").FakeDb;
  db.tables.profiles = [{ id: TEST_USER, birth_date: null, strikes: 0 }];
  const app = createApp(deps);
  const res = await app.request("/api/generations", { headers: AUTH });
  assertEquals(res.status, 403);
  assertEquals((await res.json()).error.code, "age_unconfirmed");
});

Deno.test("age-unconfirmed user can still read their profile", async () => {
  const deps = testDeps();
  const db = deps.admin as unknown as import("./testing/fakes.ts").FakeDb;
  db.tables.profiles = [{
    id: TEST_USER,
    birth_date: null,
    strikes: 0,
    prefs: {},
  }];
  const app = createApp(deps);
  const res = await app.request("/api/profile", { headers: AUTH });
  assertEquals(res.status, 200);
  assertEquals((await res.json()).profile.ageConfirmed, false);
});

Deno.test("malformed JSON → readable 400", async () => {
  const app = createApp(testDeps());
  const res = await app.request("/api/generations", {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: "{not json",
  });
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error.code, "invalid_payload");
});

Deno.test("another user's generation is invisible", async () => {
  const deps = testDeps();
  const db = deps.admin as unknown as import("./testing/fakes.ts").FakeDb;
  db.tables.generations = [
    {
      id: "g-other",
      user_id: OTHER_USER,
      kind: "image",
      status: "done",
      media_path: "x.png",
      settings: {},
      price_credits: 10,
    },
  ];
  const app = createApp(deps);
  const res = await app.request("/api/generations", { headers: AUTH });
  assertEquals(res.status, 200);
  assertEquals((await res.json()).items, []);
});

Deno.test("deleting another user's generation → 404", async () => {
  const deps = testDeps();
  const db = deps.admin as unknown as import("./testing/fakes.ts").FakeDb;
  db.tables.generations = [{
    id: "g-other",
    user_id: OTHER_USER,
    media_path: "x.png",
  }];
  const app = createApp(deps);
  const res = await app.request("/api/generations/g-other", {
    method: "DELETE",
    headers: AUTH,
  });
  assertEquals(res.status, 404);
  assertEquals(db.tables.generations.length, 1);
});

Deno.test("POST /errors answers 204 with no body", async () => {
  const app = createApp(testDeps());
  const res = await app.request("/api/errors", {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify({ message: "boom" }),
  });
  assertEquals(res.status, 204);
  assertEquals(await res.text(), "");
});

Deno.test("health needs no token", async () => {
  const deps = testDeps();
  const db = deps.admin as unknown as import("./testing/fakes.ts").FakeDb;
  db.tables.models = [{ id: "flux", enabled: true }];
  const app = createApp(deps);
  const res = await app.request("/api/health");
  assertEquals(res.status, 200);
  assertEquals((await res.json()).ok, true);
});

Deno.test("unhandled route error answers 500 with a request id", async () => {
  const deps = testDeps();
  const db = deps.admin as unknown as import("./testing/fakes.ts").FakeDb;
  db.rpcHandlers.fn_balances = () => {
    throw new Error("db down");
  };
  const app = createApp(deps);
  const res = await app.request("/api/profile", { headers: AUTH });
  assertEquals(res.status, 500);
  const body = await res.json();
  assertEquals(body.error.code, "internal");
  assertEquals(typeof body.error.requestId, "string");
});
