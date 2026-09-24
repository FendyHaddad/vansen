// The browser preflight must allow every header the web client sends, or the
// browser drops the request before it reaches the gateway. The web sends
// Idempotency-Key on generate, retry and variation (api-service.ts).
import { assert, assertEquals } from "jsr:@std/assert";
import { mcpApp } from "./testing/mcp.ts";

const WEB_HEADERS = ["authorization", "content-type", "x-vansen-client", "idempotency-key"];

async function preflight(path: string) {
  const { app } = mcpApp();
  return await app.request(`/api${path}`, {
    method: "OPTIONS",
    headers: {
      origin: "https://vansen.app",
      "access-control-request-method": "POST",
      "access-control-request-headers": WEB_HEADERS.join(","),
    },
  });
}

for (const path of ["/generations", "/generations/g1/retry", "/generations/g1/vary"]) {
  Deno.test(`preflight for POST ${path} allows every header the web sends`, async () => {
    const res = await preflight(path);
    assertEquals(res.headers.get("access-control-allow-origin"), "https://vansen.app");
    const allowed = (res.headers.get("access-control-allow-headers") ?? "").toLowerCase().split(",").map((h) => h.trim());
    for (const header of WEB_HEADERS) assert(allowed.includes(header), `${header} missing from ${allowed}`);
  });
}
