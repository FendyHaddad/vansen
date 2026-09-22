// Staging runs the api inside the local Edge runtime, where SUPABASE_URL is
// http://kong:8000 — a host a browser cannot resolve. MEDIA_PUBLIC_ORIGIN
// rewrites the signed URLs the browser receives. Unset, nothing changes.
import { assertEquals } from "jsr:@std/assert";
import { createApp } from "./app.ts";
import { FakeDb, TEST_USER, testDeps } from "./testing/fakes.ts";

const AUTH = { authorization: "Bearer test-token" };

function oneFinishedImage() {
  const deps = testDeps();
  const db = deps.admin as unknown as FakeDb;
  db.tables.generations = [{
    id: "g1",
    user_id: TEST_USER,
    kind: "image",
    family_id: "flux",
    family_name: "FLUX",
    op: "generate",
    prompt: "a cat",
    settings: {},
    price_credits: 40,
    status: "done",
    media_path: "u/1.png",
    thumb_path: "u/1.thumb.jpg",
    storage_backend: "supabase",
    deleted_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
  }];
  for (const path of ["u/1.png", "u/1.thumb.jpg"]) {
    db.storage.objects.set(`media/${path}`, {
      bytes: new Uint8Array([1]),
      contentType: "image/png",
    });
  }
  return deps;
}

Deno.test("staging: a configured origin replaces the host of signed media URLs", async () => {
  const deps = oneFinishedImage();
  deps.env.mediaPublicOrigin = "http://127.0.0.1:54321";
  const app = createApp(deps);

  const res = await app.request("/api/generations?limit=10", { headers: AUTH });
  const body = await res.json();

  assertEquals(body.items[0].thumbUrl, "http://127.0.0.1:54321/media/u/1.thumb.jpg?token=signed");
});

Deno.test("production: with no origin configured the signed URL is untouched", async () => {
  const deps = oneFinishedImage();
  const app = createApp(deps);

  const res = await app.request("/api/generations?limit=10", { headers: AUTH });
  const body = await res.json();

  assertEquals(body.items[0].thumbUrl, "https://fake.storage/media/u/1.thumb.jpg?token=signed");
});
