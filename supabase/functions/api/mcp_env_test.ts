// Where the PRM and the OAuth endpoints point assistants: hosted, derived from
// SUPABASE_URL with the web origin as issuer; locally, MCP_PUBLIC_SUPABASE_URL
// and MCP_ISSUER, honoured only when SUPABASE_URL is the kong host.
import { assertEquals } from "jsr:@std/assert";
import { mcpEnvFrom } from "./mcp/metadata.ts";

function envOf(vars: Record<string, string>) {
  return (k: string) => vars[k];
}

Deno.test("hosted: the api URL derives from SUPABASE_URL and the issuer is the web origin", () => {
  assertEquals(mcpEnvFrom(envOf({ SUPABASE_URL: "https://ref.supabase.co/" })), {
    resourceUrl: "https://ref.supabase.co/functions/v1/api/mcp",
    apiUrl: "https://ref.supabase.co/functions/v1/api",
    issuer: "https://vansen.vankode.com",
  });
});

Deno.test("hosted: stray MCP_ISSUER / MCP_PUBLIC_SUPABASE_URL secrets repoint nothing", () => {
  const env = mcpEnvFrom(envOf({
    SUPABASE_URL: "https://ref.supabase.co",
    MCP_ISSUER: "https://evil.example",
    MCP_PUBLIC_SUPABASE_URL: "https://evil.example",
  }));
  assertEquals(env?.issuer, "https://vansen.vankode.com");
  assertEquals(env?.resourceUrl, "https://ref.supabase.co/functions/v1/api/mcp");
});

Deno.test("local stack: the public URL replaces kong; the issuer defaults to <api>/oauth", () => {
  assertEquals(
    mcpEnvFrom(envOf({ SUPABASE_URL: "http://kong:8000", MCP_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" })),
    {
      resourceUrl: "http://127.0.0.1:54321/functions/v1/api/mcp",
      apiUrl: "http://127.0.0.1:54321/functions/v1/api",
      issuer: "http://127.0.0.1:54321/functions/v1/api/oauth",
    },
  );
});

Deno.test("local stack: MCP_ISSUER names a root issuer (a local web origin serving the metadata)", () => {
  const env = mcpEnvFrom(envOf({
    SUPABASE_URL: "http://kong:8000",
    MCP_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
    MCP_ISSUER: "http://127.0.0.1:4200/",
  }));
  assertEquals(env?.issuer, "http://127.0.0.1:4200");
  assertEquals(env?.apiUrl, "http://127.0.0.1:54321/functions/v1/api");
});

Deno.test("no SUPABASE_URL: no MCP env (the PRM and /oauth answer 503)", () => {
  assertEquals(mcpEnvFrom(envOf({})), undefined);
});
