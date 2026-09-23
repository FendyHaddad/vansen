// Where the PRM points assistants (Minor 4): MCP_PUBLIC_SUPABASE_URL is a
// local-stack override only, honoured when SUPABASE_URL is the kong host.
import { assertEquals } from "jsr:@std/assert";
import { mcpEnvFrom } from "./mcp/metadata.ts";

function envOf(vars: Record<string, string>) {
  return (k: string) => vars[k];
}

Deno.test("hosted: the PRM derives from SUPABASE_URL", () => {
  assertEquals(mcpEnvFrom(envOf({ SUPABASE_URL: "https://ref.supabase.co/" })), {
    resourceUrl: "https://ref.supabase.co/functions/v1/api/mcp",
    authServerUrl: "https://ref.supabase.co/auth/v1",
  });
});

Deno.test("hosted: a stray MCP_PUBLIC_SUPABASE_URL cannot repoint the PRM", () => {
  const env = mcpEnvFrom(envOf({
    SUPABASE_URL: "https://ref.supabase.co",
    MCP_PUBLIC_SUPABASE_URL: "https://evil.example",
  }));
  assertEquals(env?.resourceUrl, "https://ref.supabase.co/functions/v1/api/mcp");
  assertEquals(env?.authServerUrl, "https://ref.supabase.co/auth/v1");
});

Deno.test("local stack: MCP_PUBLIC_SUPABASE_URL replaces the unresolvable kong host", () => {
  const env = mcpEnvFrom(envOf({
    SUPABASE_URL: "http://kong:8000",
    MCP_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
  }));
  assertEquals(env?.resourceUrl, "http://127.0.0.1:54321/functions/v1/api/mcp");
});

Deno.test("no SUPABASE_URL: no MCP env (the PRM answers 503)", () => {
  assertEquals(mcpEnvFrom(envOf({})), undefined);
});
