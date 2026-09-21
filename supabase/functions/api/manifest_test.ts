import { assert, assertEquals } from "jsr:@std/assert";
import { createApp } from "./app.ts";
import { FakeDb, testDeps } from "./testing/fakes.ts";
import { CATALOG_VERSION } from "../_shared/model-families.ts";
import { QUOTE_VERSION } from "../_shared/generation-request.ts";

function withModels(rows: Array<{ id: string; enabled: boolean }>) {
  const deps = testDeps();
  const db = deps.admin as unknown as FakeDb;
  db.tables.models = rows;
  db.rpcHandlers.fn_schema_version = () => "0024";
  return deps;
}

Deno.test("the manifest reports what is actually running", async () => {
  const deps = withModels([
    { id: "flux", enabled: true },
    { id: "kling", enabled: false },
  ]);
  deps.env.release = { gitRevision: "abc1234", workerVersion: "v44", deployedAt: "2026-09-22T00:00:00Z" };
  const app = createApp(deps);

  const body = await (await app.request("/api/manifest")).json();

  assertEquals(body.gitRevision, "abc1234");
  assertEquals(body.workerVersion, "v44");
  assertEquals(body.deployedAt, "2026-09-22T00:00:00Z");
  assertEquals(body.schemaVersion, "0024");
  assertEquals(body.catalogVersion, CATALOG_VERSION);
  assertEquals(body.quoteVersion, QUOTE_VERSION);
  assertEquals(body.capabilities.flux, true);
  assertEquals(body.capabilities.kling, false, "a disabled family must report disabled");
});

Deno.test("the manifest is public — it is how you check a deploy landed", async () => {
  const app = createApp(withModels([]));
  const res = await app.request("/api/manifest");
  assertEquals(res.status, 200);
});

Deno.test("an unset revision reads as unknown, never as a stale guess", async () => {
  // The alternative is reporting the last revision we happened to know, which
  // would make a failed deploy look like a successful one.
  const deps = withModels([]);
  deps.env.release = { gitRevision: "", workerVersion: "", deployedAt: null };
  const body = await (await createApp(deps).request("/api/manifest")).json();
  assertEquals(body.gitRevision, "unknown");
  assertEquals(body.workerVersion, "unknown");
  assertEquals(body.deployedAt, null);
});

Deno.test("a database that cannot answer reports unknown, not a wrong version", async () => {
  const deps = withModels([{ id: "flux", enabled: true }]);
  const db = deps.admin as unknown as FakeDb;
  db.rpcHandlers.fn_schema_version = () => {
    throw new Error("relation does not exist");
  };
  const res = await createApp(deps).request("/api/manifest");
  assertEquals(res.status, 200, "the manifest must answer even when the RPC is missing");
  assertEquals((await res.json()).schemaVersion, "unknown");
});

Deno.test("the manifest leaks no secret", async () => {
  const deps = withModels([{ id: "flux", enabled: true }]);
  deps.env.release = { gitRevision: "abc1234", workerVersion: "v44", deployedAt: null };
  const text = await (await createApp(deps).request("/api/manifest")).text();
  for (const needle of ["sk_", "service_role", "SUPABASE_SERVICE", "whsec_", "secret", "token", "password"]) {
    assert(
      !text.toLowerCase().includes(needle.toLowerCase()),
      `manifest leaked "${needle}": ${text}`,
    );
  }
});

Deno.test("the manifest agrees with /capabilities about which families are on", async () => {
  // Two endpoints disagreeing about what is enabled is worse than either being
  // wrong: the landing page would advertise one thing and the deploy check
  // would confirm another.
  const deps = withModels([
    { id: "flux", enabled: true },
    { id: "kling", enabled: false },
  ]);
  const app = createApp(deps);

  const manifest = await (await app.request("/api/manifest")).json();
  const capabilities = await (await app.request("/api/capabilities")).json();

  const manifestOn = Object.entries(manifest.capabilities)
    .filter(([, on]) => on).map(([id]) => id).sort();
  assertEquals(manifestOn, [...capabilities.enabledFamilyIds].sort());
});
