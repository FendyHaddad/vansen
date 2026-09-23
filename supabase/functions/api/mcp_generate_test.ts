// The money-spending MCP tools (spec §4, §5, §8): generate_image, upscale_image
// and vary_image — wait-then-return, thumbnails, idempotency (no double
// charge), the `mcp` budget, the client tag, and the mapped refusals.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { CATALOG_VERSION } from "./_shared/model-families.ts";
import { FakeDb, fakeModeration, TEST_USER } from "./testing/fakes.ts";
import { callTool, jsonOf, mcpApp, SESSION_JWT, textOf } from "./testing/mcp.ts";
import type { ApiDeps } from "./app.ts";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

function seed(db: FakeDb, plan = "pro") {
  db.tables.subscriptions = [{
    user_id: TEST_USER, plan, status: "active", current_period_end: "2099-01-01T00:00:00Z",
  }];
  db.tables.models = [
    { id: "nano-banana", enabled: true, min_plan: "studio" },
    { id: "flux", enabled: true, min_plan: "studio" },
    { id: "gpt-image", enabled: true, min_plan: "pro" },
    { id: "upscaler", enabled: true, min_plan: "studio" },
  ];
}

/** The worker, as far as a test cares: every pending image finishes. */
function finishAll(db: FakeDb) {
  for (const row of db.tables.generations) {
    if (row.status !== "pending") continue;
    row.status = "done";
    row.media_path = `${TEST_USER}/${row.id}.png`;
    row.thumb_path = `${TEST_USER}/${row.id}.thumb.jpg`;
    row.storage_backend = "supabase";
    db.storage.from("media").upload(String(row.media_path), new Uint8Array([9]), { contentType: "image/png" });
    db.storage.from("media").upload(String(row.thumb_path), JPEG, { contentType: "image/jpeg" });
  }
}

/** An app whose "worker" finishes on the first poll. */
function finishingApp(over: Partial<ApiDeps> = {}) {
  let db: FakeDb | null = null;
  const made = mcpApp({ sleep: () => Promise.resolve(finishAll(db!)), ...over });
  db = made.db;
  seed(made.db);
  return made;
}

function reserveCalls(db: FakeDb) {
  return db.rpcCalls.filter((c) => c.name === "fn_reserve_generation");
}

Deno.test("generate_image returns the finished image: thumbnail block + full-size link", async () => {
  const { app, db } = finishingApp();
  const result = await callTool(app, "generate_image", { prompt: "a red fox", model: "flux" });
  assert(!result.isError, textOf(result));
  const image = result.content.find((b) => b.type === "image");
  assert(image, "an image block");
  assertEquals(image.mimeType, "image/jpeg");
  assertEquals(image.data, btoa(String.fromCharCode(...JPEG)));
  const link = result.content.find((b) => b.type === "resource_link");
  assert(link, "a resource_link to the full image");
  assertStringIncludes(String(link.uri), "https://fake.storage/media/");
  assertStringIncludes(String(link.uri), "g0.png");
  const data = jsonOf(result);
  assertEquals(data.items[0].id, "g0");
  assertEquals(data.items[0].status, "done");
  assert(data.items[0].creditsCharged > 0);
  assertEquals(reserveCalls(db).length, 1);
});

Deno.test("generations submitted over MCP are stored with client 'mcp', whatever the header says", async () => {
  const { app, db } = finishingApp();
  await callTool(app, "generate_image", { prompt: "a red fox" }, { headers: { "x-vansen-client": "ios" } });
  const items = reserveCalls(db)[0].args.p_items as Record<string, unknown>[];
  assertEquals(items[0].client, "mcp");
});

Deno.test("still rendering after the wait: the tool returns the ids and says how to collect them", async () => {
  const { app, db } = mcpApp();
  seed(db);
  const result = await callTool(app, "generate_image", { prompt: "a red fox", count: 2 });
  assert(!result.isError);
  const data = jsonOf(result);
  assertEquals(data.items.map((i: { id: string }) => i.id), ["g0", "g1"]);
  assertEquals(data.items[0].status, "pending");
  assertStringIncludes(textOf(result), "get_generation");
  assertEquals(result.content.filter((b) => b.type === "image").length, 0);
});

Deno.test("count becomes the batch and options land on a catalog combo", async () => {
  const { app, db } = finishingApp();
  const result = await callTool(app, "generate_image", {
    prompt: "a red fox", model: "flux", count: 3, options: { aspectRatio: "16:9" },
  });
  assert(!result.isError, textOf(result));
  const items = reserveCalls(db)[0].args.p_items as Record<string, unknown>[];
  assertEquals(items.length, 3);
  assertEquals((items[0].settings as Record<string, unknown>).aspectRatio, "16:9");
  assertEquals(result.content.filter((b) => b.type === "image").length, 3);
});

Deno.test("an invalid option is refused before any charge, with the valid values", async () => {
  const { app, db } = finishingApp();
  const result = await callTool(app, "generate_image", {
    prompt: "a red fox", model: "flux", options: { aspectRatio: "7:3" },
  });
  assert(result.isError);
  assertStringIncludes(textOf(result), "16:9");
  assertEquals(jsonOf(result).error, "invalid_settings");
  assertEquals(reserveCalls(db).length, 0);
});

Deno.test("a style resolves by label and reaches the submission", async () => {
  const { app, db } = finishingApp();
  const result = await callTool(app, "generate_image", { prompt: "a red fox", style: "Oil painting" });
  assert(!result.isError, textOf(result));
  const payload = reserveCalls(db)[0].args.p_payload as Record<string, unknown>;
  assertEquals(payload.styleId, "oil-painting");
});

Deno.test("a retry with the same JSON-RPC id and arguments, inside the window, charges once", async () => {
  const { app, db } = finishingApp();
  const args = { prompt: "a red fox", model: "flux" };
  const first = await callTool(app, "generate_image", args, { id: 7 });
  const again = await callTool(app, "generate_image", args, { id: 7 });
  assertEquals(jsonOf(first).items[0].id, jsonOf(again).items[0].id);
  assertEquals(db.tables.generations.length, 1, "one generation, one charge");
  assertEquals(db.tables.submissions.length, 1);
});

Deno.test("the caller's idempotency_key dedupes across different request ids", async () => {
  const { app, db } = finishingApp();
  const args = { prompt: "a red fox", idempotency_key: "my-key-1" };
  await callTool(app, "generate_image", args, { id: 1 });
  await callTool(app, "generate_image", args, { id: 2 });
  assertEquals(db.tables.generations.length, 1);
  const keys = reserveCalls(db).map((c) => c.args.p_key);
  assertEquals(keys[0], keys[1]);
  assert(/^[0-9a-f-]{36}$/.test(String(keys[0])), "a UUID the RPC accepts");
});

Deno.test("the same idempotency_key with different arguments is refused, not replayed", async () => {
  const { app, db } = finishingApp();
  await callTool(app, "generate_image", { prompt: "a red fox", idempotency_key: "k" });
  const result = await callTool(app, "generate_image", { prompt: "a blue fox", idempotency_key: "k" });
  assert(result.isError);
  assertEquals(jsonOf(result).error, "idempotency_conflict");
  assertEquals(db.tables.generations.length, 1);
});

Deno.test("a replay says it was already submitted and that nothing new was charged", async () => {
  const { app } = finishingApp();
  const args = { prompt: "a red fox", model: "flux" };
  const first = await callTool(app, "generate_image", args, { id: 8 });
  assertStringIncludes(textOf(first), "credits charged");
  const again = await callTool(app, "generate_image", args, { id: 8 });
  assertStringIncludes(textOf(again), "already submitted");
  assertStringIncludes(textOf(again), "nothing new charged");
  assert(!textOf(again).includes("credits charged for this request"), textOf(again));
});

Deno.test("same id + args after the retry window is a new generation", async () => {
  const { app, db } = finishingApp();
  const args = { prompt: "a red fox", model: "flux" };
  db.setNow(new Date("2026-09-20T10:00:00.000Z"));
  await callTool(app, "generate_image", args, { id: 3 });
  db.setNow(new Date("2026-09-20T10:05:00.000Z"));
  const later = await callTool(app, "generate_image", args, { id: 3 });
  assertEquals(db.tables.generations.length, 2, "a deliberate re-run generates anew");
  assertStringIncludes(textOf(later), "credits charged");
});

Deno.test("a retry that crosses into the next time bucket still replays", async () => {
  const { app, db } = finishingApp();
  const args = { prompt: "a red fox", model: "flux" };
  // 10:01:59 and 10:02:01 sit in adjacent 120 s buckets.
  db.setNow(new Date("2026-09-20T10:01:59.000Z"));
  await callTool(app, "generate_image", args, { id: 4 });
  db.setNow(new Date("2026-09-20T10:02:01.000Z"));
  await callTool(app, "generate_image", args, { id: 4 });
  assertEquals(db.tables.generations.length, 1, "one generation, one charge");
});

Deno.test("a conflict on a derived key is a plain try-again, not a key the user never gave", async () => {
  const { app, db } = finishingApp();
  db.rpcHandlers.fn_reserve_generation = () => {
    throw new Error("idempotency_conflict");
  };
  const result = await callTool(app, "generate_image", { prompt: "a red fox" });
  assert(result.isError);
  assertEquals(jsonOf(result).error, "idempotency_conflict");
  const sentence = textOf(result).split("\n")[0];
  assert(!/idempotency_key/i.test(sentence), sentence);
  assertStringIncludes(sentence.toLowerCase(), "try again");
});

Deno.test("a replay never re-serves an image the user has since deleted", async () => {
  const { app, db } = finishingApp();
  const args = { prompt: "a red fox", model: "flux" };
  await callTool(app, "generate_image", args, { id: 21 });
  db.tables.generations[0].deleted_at = "2026-09-20T00:00:01.000Z";
  const again = await callTool(app, "generate_image", args, { id: 21 });
  assertEquals(again.content.filter((b) => b.type === "image").length, 0);
  assertEquals(jsonOf(again).items.length, 0);
  assertEquals(db.tables.generations.length, 1);
});

Deno.test("different request ids without a key are different generations", async () => {
  const { app, db } = finishingApp();
  await callTool(app, "generate_image", { prompt: "a red fox" }, { id: 11 });
  await callTool(app, "generate_image", { prompt: "a red fox" }, { id: 12 });
  assertEquals(db.tables.generations.length, 2);
});

Deno.test("the mcp budget is independent of the app's generation budget", async () => {
  const { app, db } = finishingApp();
  db.rpcHandlers.fn_take_request_slot = (args) =>
    args.p_bucket === "mcp"
      ? { allowed: true, retryAfterSeconds: 0 }
      : { allowed: false, retryAfterSeconds: 30 };
  const result = await callTool(app, "generate_image", { prompt: "a red fox" });
  assert(!result.isError, textOf(result));
  const buckets = db.rpcCalls.filter((c) => c.name === "fn_take_request_slot").map((c) => c.args.p_bucket);
  assertEquals(buckets, ["mcp"]);

  const appRes = await app.request("/api/generations", {
    method: "POST",
    headers: { authorization: `Bearer ${SESSION_JWT}`, "content-type": "application/json" },
    body: JSON.stringify({ op: "generate", familyId: "flux", prompt: "x" }),
  });
  assertEquals(appRes.status, 429, "the app's own budget is still its own");
});

Deno.test("an exhausted mcp budget is a readable rate_limited tool error", async () => {
  const { app, db } = finishingApp();
  db.rpcHandlers.fn_take_request_slot = (args) =>
    args.p_bucket === "mcp"
      ? { allowed: false, retryAfterSeconds: 42 }
      : { allowed: true, retryAfterSeconds: 0 };
  const result = await callTool(app, "generate_image", { prompt: "a red fox" });
  assert(result.isError);
  assertEquals(jsonOf(result).error, "rate_limited");
  assertStringIncludes(textOf(result), "42 seconds");
  assertEquals(reserveCalls(db).length, 0);
});

Deno.test("read-only tools never draw on the mcp budget", async () => {
  const { app, db } = finishingApp();
  await callTool(app, "get_account");
  await callTool(app, "list_models");
  await callTool(app, "list_recent");
  assertEquals(db.rpcCalls.filter((c) => c.name === "fn_take_request_slot").length, 0);
});

Deno.test("mapped refusal: content_policy", async () => {
  const moderation = fakeModeration();
  const { app, db } = finishingApp({ moderate: moderation.moderate });
  db.rpcHandlers.fn_increment_strike = () => 1;
  moderation.next({ state: "blocked", categories: { violence: 0.99 } });
  const result = await callTool(app, "generate_image", { prompt: "something bad" });
  assert(result.isError);
  assertEquals(jsonOf(result).error, "content_policy");
  assertStringIncludes(textOf(result), "content policy");
  assertStringIncludes(textOf(result), "Do not retry or reword automatically; tell the user.");
  assert(!/rephrase/i.test(textOf(result)), "never invite the assistant to reword and resubmit");
  assertEquals(reserveCalls(db).length, 0);
});

Deno.test("mapped refusal: insufficient_credits names where to top up", async () => {
  const { app, db } = finishingApp();
  db.rpcHandlers.fn_reserve_generation = () => {
    throw new Error("insufficient_balance");
  };
  const result = await callTool(app, "generate_image", { prompt: "a red fox" });
  assert(result.isError);
  assertEquals(jsonOf(result).error, "insufficient_credits");
  assertStringIncludes(textOf(result), "vansen.vankode.com/app/billing");
});

Deno.test("mapped refusal: subscription_required", async () => {
  const { app, db } = finishingApp();
  db.tables.subscriptions = [];
  const result = await callTool(app, "generate_image", { prompt: "a red fox" });
  assert(result.isError);
  assertEquals(jsonOf(result).error, "subscription_required");
  assertStringIncludes(textOf(result), "vansen.vankode.com/app/billing");
});

Deno.test("mapped refusal: pro_required for a Pro model on Studio", async () => {
  const { app, db } = finishingApp();
  seed(db, "studio");
  const result = await callTool(app, "generate_image", { prompt: "a red fox", model: "gpt-image" });
  assert(result.isError);
  assertEquals(jsonOf(result).error, "pro_required");
});

Deno.test("mapped refusal: account_suspended", async () => {
  const { app, db } = finishingApp();
  db.tables.profiles[0].strikes = 2;
  const result = await callTool(app, "generate_image", { prompt: "a red fox" });
  assert(result.isError);
  assertEquals(jsonOf(result).error, "account_suspended");
});

Deno.test("mapped refusal: age_unconfirmed, while get_account still answers", async () => {
  const { app, db } = finishingApp();
  db.tables.profiles[0].birth_date = null;
  const result = await callTool(app, "generate_image", { prompt: "a red fox" });
  assert(result.isError);
  assertEquals(jsonOf(result).error, "age_unconfirmed");
  const account = await callTool(app, "get_account");
  assert(!account.isError);
});

Deno.test("upscale_image upscales a finished image and returns it", async () => {
  const { app, db } = finishingApp();
  db.tables.generations = [{
    id: "done1", user_id: TEST_USER, kind: "image", family_id: "flux", family_name: "FLUX",
    op: "generate", prompt: "a red fox", settings: { aspectRatio: "1:1" }, price_credits: 5,
    status: "done", media_path: `${TEST_USER}/done1.png`, storage_backend: "supabase", deleted_at: null,
  }];
  db.storage.from("media").upload(`${TEST_USER}/done1.png`, new Uint8Array([1]), { contentType: "image/png" });
  const result = await callTool(app, "upscale_image", { id: "done1" });
  assert(!result.isError, textOf(result));
  const items = reserveCalls(db)[0].args.p_items as Record<string, unknown>[];
  assertEquals(items[0].op, "upscale");
  assertEquals(items[0].parentId, "done1");
  assertEquals(items[0].client, "mcp");
  assert(result.content.some((b) => b.type === "image"));
});

Deno.test("upscale_image of an unfinished image is parent_not_ready; unknown id is not_found", async () => {
  const { app, db } = finishingApp();
  db.tables.generations = [{
    id: "p1", user_id: TEST_USER, kind: "image", family_id: "flux", op: "generate",
    prompt: "a red fox", settings: {}, status: "pending", media_path: null, deleted_at: null,
  }];
  const pending = await callTool(app, "upscale_image", { id: "p1" });
  assertEquals(jsonOf(pending).error, "parent_not_ready");
  const missing = await callTool(app, "upscale_image", { id: "nope" });
  assertEquals(jsonOf(missing).error, "not_found");
  assertEquals(reserveCalls(db).length, 0);
});

function seedVariable(db: FakeDb, snapshot: Record<string, unknown> = {}) {
  db.tables.request_snapshots = [{
    id: "snap-1", user_id: TEST_USER, version: 1,
    body: {
      version: 1, op: "generate", familyId: "flux", prompt: "a red fox",
      settings: { aspectRatio: "1:1" }, referenceUploadIds: [],
      referenceSlots: { first: null, last: null, references: [] },
      maskUploadId: null, personaId: null, styleId: null, trendId: null, mode: null,
      parentId: null, catalogVersion: CATALOG_VERSION, quoteVersion: 1, ...snapshot,
    },
  }];
  db.tables.generations = [{
    id: "orig", user_id: TEST_USER, kind: "image", family_id: "flux", family_name: "FLUX",
    op: "generate", prompt: "a red fox", settings: { aspectRatio: "1:1" }, price_credits: 5,
    status: "done", snapshot_id: "snap-1", media_path: `${TEST_USER}/orig.png`,
    storage_backend: "supabase", deleted_at: null,
  }];
  db.storage.from("media").upload(`${TEST_USER}/orig.png`, new Uint8Array([1]), { contentType: "image/png" });
}

Deno.test("vary_image runs the existing variation service and returns the new image", async () => {
  const { app, db } = finishingApp();
  seedVariable(db);
  const result = await callTool(app, "vary_image", { id: "orig" });
  assert(!result.isError, textOf(result));
  const items = reserveCalls(db)[0].args.p_items as Record<string, unknown>[];
  assertEquals(items[0].parentId, "orig");
  assertEquals(items[0].client, "mcp");
  assert(result.content.some((b) => b.type === "image"));
});

Deno.test("vary_image of an edit is refused with the variation service's reason", async () => {
  const { app, db } = finishingApp();
  seedVariable(db, { op: "edit" });
  const result = await callTool(app, "vary_image", { id: "orig" });
  assert(result.isError);
  assertEquals(jsonOf(result).error, "not_variable");
  assertEquals(reserveCalls(db).length, 0);
});

Deno.test("a repeated vary_image call with the same request id charges once", async () => {
  const { app, db } = finishingApp();
  seedVariable(db);
  await callTool(app, "vary_image", { id: "orig" }, { id: 99 });
  await callTool(app, "vary_image", { id: "orig" }, { id: 99 });
  assertEquals(db.tables.submissions.length, 1);
});

Deno.test("a moderation outage is one plain instruction, charged nothing", async () => {
  const moderation = fakeModeration();
  const { app, db } = finishingApp({ moderate: moderation.moderate });
  moderation.next({ state: "unavailable", reason: "moderation_key_missing", retryAfterSeconds: 5 });
  const result = await callTool(app, "generate_image", { prompt: "a red fox" });
  assert(result.isError);
  assertEquals(jsonOf(result).error, "moderation_unavailable");
  const sentence = textOf(result).split("\n")[0];
  assertEquals(sentence.match(/try again/gi)?.length, 1, sentence);
  assertEquals(reserveCalls(db).length, 0);
});
