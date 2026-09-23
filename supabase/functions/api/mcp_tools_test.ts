// The read-side MCP tools and the tool plumbing (spec §4, §5, §8): tools/list,
// get_account, list_models, get_generation, cancel_generation, list_recent,
// and unexpected failures logged to app_errors with client 'mcp'.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { FakeDb, TEST_USER } from "./testing/fakes.ts";
import { callTool, jsonOf, mcpApp, rpc, textOf } from "./testing/mcp.ts";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 1]);
const P1 = "00000000-0000-4000-8000-000000000001";
const D1 = "00000000-0000-4000-8000-000000000002";
const F1 = "00000000-0000-4000-8000-000000000003";
const X1 = "00000000-0000-4000-8000-000000000004";

function seed(db: FakeDb) {
  db.tables.subscriptions = [{
    user_id: TEST_USER, plan: "pro", status: "active", current_period_end: "2099-01-01T00:00:00Z",
  }];
  db.tables.models = [
    { id: "nano-banana", enabled: true, min_plan: "studio" },
    { id: "flux", enabled: true, min_plan: "studio" },
    { id: "seedream", enabled: false, min_plan: "studio" },
    { id: "upscaler", enabled: true, min_plan: "studio" },
  ];
  db.rpcHandlers.fn_balances = () => [{ plan_credits: 1200, pack_credits: 300 }];
}

function row(id: string, over: Record<string, unknown> = {}) {
  return {
    id, user_id: TEST_USER, kind: "image", family_id: "flux", family_name: "FLUX",
    op: "generate", prompt: `prompt ${id}`, settings: { aspectRatio: "1:1" }, price_credits: 5,
    status: "done", media_path: `${TEST_USER}/${id}.png`, thumb_path: `${TEST_USER}/${id}.thumb.jpg`,
    storage_backend: "supabase", deleted_at: null, created_at: "2026-09-20T00:00:00Z", ...over,
  };
}

function store(db: FakeDb, id: string) {
  db.storage.from("media").upload(`${TEST_USER}/${id}.png`, new Uint8Array([1]), { contentType: "image/png" });
  db.storage.from("media").upload(`${TEST_USER}/${id}.thumb.jpg`, JPEG, { contentType: "image/jpeg" });
}

Deno.test("tools/list offers the eight v1 tools with honest annotations", async () => {
  const { app } = mcpApp();
  const answer = await rpc(app, "tools/list");
  const tools = answer.body.result.tools as Array<{
    name: string; description: string; annotations: Record<string, boolean>;
  }>;
  assertEquals(tools.map((t) => t.name).sort(), [
    "cancel_generation", "generate_image", "get_account", "get_generation",
    "list_models", "list_recent", "upscale_image", "vary_image",
  ]);
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  for (const name of ["get_account", "list_models", "get_generation", "list_recent"]) {
    assertEquals(byName[name].annotations.readOnlyHint, true, name);
  }
  for (const name of ["generate_image", "upscale_image", "vary_image", "cancel_generation"]) {
    assertEquals(byName[name].annotations.readOnlyHint, false, name);
  }
  assertEquals(byName.generate_image.annotations.idempotentHint, false);
  assertStringIncludes(byName.generate_image.description, "credits");
  assertStringIncludes(byName.generate_image.description, "$");
});

Deno.test("get_account: plan, entitlement and both credit buckets", async () => {
  const { app, db } = mcpApp();
  seed(db);
  const result = await callTool(app, "get_account");
  assert(!result.isError);
  const data = jsonOf(result);
  assertEquals(data.plan, "pro");
  assertEquals(data.entitled, true);
  assertEquals(data.credits, { plan: 1200, pack: 300, total: 1500 });
  assertStringIncludes(textOf(result), "1500");
});

Deno.test("get_account without a plan says so and where to subscribe", async () => {
  const { app, db } = mcpApp();
  seed(db);
  db.tables.subscriptions = [];
  const result = await callTool(app, "get_account");
  const data = jsonOf(result);
  assertEquals(data.plan, null);
  assertEquals(data.entitled, false);
  assertStringIncludes(textOf(result), "vansen.vankode.com/app/billing");
});

Deno.test("list_models: live image families with options, defaults, prices, and styles", async () => {
  const { app, db } = mcpApp();
  seed(db);
  const result = await callTool(app, "list_models");
  assert(!result.isError);
  const data = jsonOf(result);
  assertEquals(data.models.map((m: { id: string }) => m.id), ["nano-banana", "flux"]);
  const flux = data.models.find((m: { id: string }) => m.id === "flux");
  assert(Array.isArray(flux.options.aspectRatio) && flux.options.aspectRatio.includes("16:9"));
  assert(flux.defaults.aspectRatio);
  assert(flux.creditsPerImage > 0);
  assert(flux.creditsRange.min <= flux.creditsPerImage && flux.creditsPerImage <= flux.creditsRange.max);
  assert(data.styles.length > 0 && data.styles[0].id);
  assertEquals(data.upscale.enabled, true);
  assertStringIncludes(textOf(result), "1 credit = $0.01");
});

Deno.test("get_generation: a pending job reports status and progress", async () => {
  const { app, db } = mcpApp();
  seed(db);
  db.tables.generations = [row(P1, { status: "pending", media_path: null, thumb_path: null })];
  db.tables.jobs = [{
    id: "j1", user_id: TEST_USER, generation_id: P1, progress: 40, phase: "rendering",
    claimed_at: null, created_at: "2026-09-20T00:00:00Z", queue_position: null,
  }];
  const result = await callTool(app, "get_generation", { id: P1 });
  assert(!result.isError);
  const data = jsonOf(result);
  assertEquals(data.status, "pending");
  assertEquals(data.progress, 40);
  assertEquals(result.content.filter((b) => b.type === "image").length, 0);
});

Deno.test("get_generation: a finished image comes with its thumbnail and full link", async () => {
  const { app, db } = mcpApp();
  seed(db);
  db.tables.generations = [row(D1)];
  store(db, D1);
  const result = await callTool(app, "get_generation", { id: D1 });
  assertEquals(jsonOf(result).status, "done");
  assert(result.content.some((b) => b.type === "image" && b.mimeType === "image/jpeg"));
  assert(result.content.some((b) => b.type === "resource_link"));
});

Deno.test("get_generation: a failed one gives the reason; an unknown id is not_found", async () => {
  const { app, db } = mcpApp();
  seed(db);
  db.tables.generations = [row(F1, {
    status: "failed", media_path: null, thumb_path: null,
    failure_code: "provider_error", failure_message: "The model could not render this. Credits refunded.",
  })];
  const failed = await callTool(app, "get_generation", { id: F1 });
  assertEquals(jsonOf(failed).status, "failed");
  assertStringIncludes(textOf(failed), "Credits refunded");
  const missing = await callTool(app, "get_generation", { id: "nope" });
  assert(missing.isError);
  assertEquals(jsonOf(missing).error, "not_found");
});

Deno.test("get_generation of a malformed id is not_found, never a database error", async () => {
  const { app, db } = mcpApp();
  seed(db);
  // Postgres refuses a non-uuid in an `in (...)` on a uuid column; the fake
  // is told to fail the same way.
  db.failNext("jobs.select", 'invalid input syntax for type uuid: "nope"');
  const result = await callTool(app, "get_generation", { id: "nope" });
  assert(result.isError);
  assertEquals(jsonOf(result).error, "not_found");
});

Deno.test("get_generation never shows another user's item", async () => {
  const { app, db } = mcpApp();
  seed(db);
  db.tables.generations = [row(X1, { user_id: "someone-else" })];
  const result = await callTool(app, "get_generation", { id: X1 });
  assertEquals(jsonOf(result).error, "not_found");
});

Deno.test("cancel_generation refunds work that never started", async () => {
  const { app, db } = mcpApp();
  seed(db);
  db.tables.generations = [row("c1", { status: "pending", media_path: null })];
  db.tables.jobs = [{
    id: "j1", user_id: TEST_USER, generation_id: "c1", state: "ready", provider_ref: null,
    lease_token: null, error: null, created_at: "2026-09-20T00:00:00Z",
  }];
  db.rpcHandlers.fn_settle_job = () => ({ settled: true, refunded: 5 });
  const result = await callTool(app, "cancel_generation", { id: "c1" });
  assert(!result.isError, textOf(result));
  const data = jsonOf(result);
  assertEquals(data.cancelled, true);
  assertEquals(typeof data.refundedCredits, "number");
});

Deno.test("cancel_generation of running work says it is cancelling", async () => {
  const { app, db } = mcpApp();
  seed(db);
  db.tables.generations = [row("c2", { status: "pending", media_path: null })];
  db.tables.jobs = [{
    id: "j2", user_id: TEST_USER, generation_id: "c2", state: "submitted", provider_ref: "ref",
    lease_token: null, error: null, created_at: "2026-09-20T00:00:00Z",
  }];
  const result = await callTool(app, "cancel_generation", { id: "c2" });
  assert(!result.isError);
  assertEquals(jsonOf(result).cancelling, true);
  assertStringIncludes(textOf(result), "refund");
});

Deno.test("cancel_generation of a finished item is a readable refusal", async () => {
  const { app, db } = mcpApp();
  seed(db);
  db.tables.generations = [row("c3")];
  const result = await callTool(app, "cancel_generation", { id: "c3" });
  assert(result.isError);
  assertEquals(jsonOf(result).error, "not_pending");
});

Deno.test("list_recent: newest first, capped, with thumbnail links", async () => {
  const { app, db } = mcpApp();
  seed(db);
  db.tables.generations = ["a", "b", "c", "d"].map((id, n) =>
    row(id, { created_at: `2026-09-2${n}T00:00:00Z` })
  );
  for (const id of ["a", "b", "c", "d"]) store(db, id);
  const result = await callTool(app, "list_recent", { limit: 3 });
  assert(!result.isError);
  const data = jsonOf(result);
  assertEquals(data.items.map((i: { id: string }) => i.id), ["d", "c", "b"]);
  assertEquals(data.items[0].prompt, "prompt d");
  assertEquals(data.items[0].model, "FLUX");
  assertEquals(data.items[0].status, "done");
  assertStringIncludes(data.items[0].thumbnailUrl, "d.thumb.jpg");
});

Deno.test("an unexpected failure is a tool error and lands in app_errors with client 'mcp'", async () => {
  const { app, db } = mcpApp();
  seed(db);
  db.rpcHandlers.fn_balances = () => {
    throw new Error("db down");
  };
  db.tables.app_errors = [];
  const result = await callTool(app, "get_account");
  assert(result.isError);
  assertEquals(jsonOf(result).error, "internal");
  await new Promise((r) => setTimeout(r, 0));
  const logged = db.tables.app_errors.find((e) => e.code === "mcp_tool_failed");
  assert(logged, "app_errors row");
  assertEquals(logged.client, "mcp");
  assertEquals(logged.route, "/api/mcp");
});

Deno.test("every tool call writes one structured log line", async () => {
  const { app, db } = mcpApp();
  seed(db);
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    await callTool(app, "get_account");
  } finally {
    console.log = original;
  }
  const line = lines.map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  }).find((l) => l?.event === "mcp_tool");
  assert(line, "an mcp_tool log line");
  assertEquals(line.tool, "get_account");
  assertEquals(line.user, TEST_USER);
  assertEquals(line.clientId, "11111111-2222-4333-8444-555555555555");
  assertEquals(line.outcome, "ok");
  assertEquals(typeof line.ms, "number");
});
