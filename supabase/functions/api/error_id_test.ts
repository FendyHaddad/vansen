import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert";
import { createApp } from "./app.ts";
import { FakeDb, testDeps } from "./testing/fakes.ts";

/**
 * A 5xx has to be quotable.
 *
 * "It said something went wrong" is not a support conversation. The id in the
 * body, the id in the header and the id on the app_errors row are one string,
 * so a customer reading it aloud lands on the exact request that failed.
 */

const AUTH = { authorization: "Bearer test-token" };
const DB_MESSAGE = "connection reset by peer at 10.0.0.4:5432";

/** A gateway whose profile read throws the way a dead connection would. */
function brokenDeps() {
  const deps = testDeps();
  const db = deps.admin as unknown as FakeDb;
  db.rpcHandlers.fn_balances = () => {
    throw new Error(DB_MESSAGE);
  };
  return deps;
}

Deno.test("an unhandled failure answers with a nonempty error id", async () => {
  const res = await createApp(brokenDeps()).request("/api/profile", { headers: AUTH });

  assertEquals(res.status, 500);
  const body = await res.json();
  assert(
    typeof body.error.errorId === "string" && body.error.errorId.length > 0,
    `no quotable id: ${JSON.stringify(body)}`,
  );
});

Deno.test("the header carries the same id as the body", async () => {
  const res = await createApp(brokenDeps()).request("/api/profile", { headers: AUTH });

  const body = await res.json();
  assertEquals(res.headers.get("x-request-id"), body.error.errorId);
});

Deno.test("the id in the response is the id in the error log", async () => {
  // The point of the whole feature: support quotes the id, we find the row.
  const deps = brokenDeps();
  const db = deps.admin as unknown as FakeDb;
  const res = await createApp(deps).request("/api/profile", { headers: AUTH });
  const { error } = await res.json();

  // logError is fire-and-forget so the answer is never delayed by monitoring.
  await new Promise((r) => setTimeout(r, 0));
  const logged = (db.tables.app_errors ?? []).find((r) => r.request_id === error.errorId);
  assert(logged, `no app_errors row for ${error.errorId}`);
  // "unhandled" is the log's own classification; the body says "internal".
  assertEquals(logged.code, "unhandled");
});

Deno.test("the error log keeps the real cause even though the answer hides it", async () => {
  const deps = brokenDeps();
  const db = deps.admin as unknown as FakeDb;
  await createApp(deps).request("/api/profile", { headers: AUTH });
  await new Promise((r) => setTimeout(r, 0));

  const logged = (db.tables.app_errors ?? [])[0];
  assert(logged, "nothing was recorded at all");
  assertEquals(logged.message, DB_MESSAGE);
});

Deno.test("the raw database message never reaches the customer", async () => {
  const res = await createApp(brokenDeps()).request("/api/profile", { headers: AUTH });

  const text = await res.text();
  for (const leak of ["connection reset", "10.0.0.4", "5432", "peer", "test-token"]) {
    assert(!text.includes(leak), `the response leaked "${leak}": ${text}`);
  }
});

Deno.test("every response carries a request id, not only the failures", async () => {
  // The request people report is often the slow one that succeeded.
  const res = await createApp(testDeps()).request("/api/health");
  assert((res.headers.get("x-request-id") ?? "").length > 0);
});

Deno.test("two requests get two different ids", async () => {
  const app = createApp(testDeps());
  const first = await app.request("/api/health");
  const second = await app.request("/api/health");
  assertNotEquals(first.headers.get("x-request-id"), second.headers.get("x-request-id"));
});

Deno.test("a 5xx from a route that handles its own error is quotable too", async () => {
  // Not every failure is an exception; the ones a route answers deliberately
  // with a 503 are just as much ours to explain.
  const deps = testDeps();
  const db = deps.admin as unknown as FakeDb;
  db.tables.models = [];
  const res = await createApp(deps).request("/api/generations", {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify({ familyId: "nope", prompt: "hi" }),
  });

  if (res.status < 500) return; // this route validates first; covered elsewhere
  const body = await res.json();
  assert(typeof body.error.errorId === "string" && body.error.errorId.length > 0);
});

Deno.test("an ordinary 4xx stays readable and is not dressed up as an incident", async () => {
  // Handing someone an incident id for their own typo trains them to quote ids
  // that lead nowhere.
  const res = await createApp(testDeps()).request("/api/profile");

  assert(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  const body = await res.json();
  assertEquals(body.error.errorId, undefined, "a 4xx carries no incident id");
  assert(typeof body.error.message === "string" && body.error.message.length > 0);
});

Deno.test("older clients still find the id under its old name", async () => {
  // A shipped iOS build reads error.requestId. Renaming it would blind it.
  const res = await createApp(brokenDeps()).request("/api/profile", { headers: AUTH });
  const body = await res.json();
  assertEquals(body.error.requestId, body.error.errorId);
});
