// Drift gate (spec R1): the static metadata the web origin serves at
// https://vansen.vankode.com/.well-known/oauth-authorization-server must equal
// what the gateway builds for the hosted issuer and api, and the PRM must name
// that issuer.
import { assertEquals } from "jsr:@std/assert";
import { buildAsMetadata, DEFAULT_ISSUER } from "./oauth/metadata.ts";
import { mcpEnvFrom, protectedResourceMetadata } from "./mcp/metadata.ts";

const HOSTED_API = "https://bnorhcxhvxydkgvcxjad.supabase.co/functions/v1/api";
const STATIC_FILE = new URL("../../../public/.well-known/oauth-authorization-server", import.meta.url);

Deno.test("the static AS metadata file equals buildAsMetadata for the hosted issuer and api", async () => {
  const onDisk = JSON.parse(await Deno.readTextFile(STATIC_FILE));
  assertEquals(onDisk, buildAsMetadata("https://vansen.vankode.com", HOSTED_API));
});

Deno.test("the metadata advertises the RFC 9207 iss parameter", () => {
  assertEquals(buildAsMetadata(DEFAULT_ISSUER, HOSTED_API).authorization_response_iss_parameter_supported, true);
});

Deno.test("the hosted PRM names the web origin as its only authorization server", () => {
  const env = mcpEnvFrom((k) => ({ SUPABASE_URL: "https://bnorhcxhvxydkgvcxjad.supabase.co" })[k]);
  assertEquals(env?.apiUrl, HOSTED_API);
  const prm = protectedResourceMetadata(env!);
  assertEquals(prm.authorization_servers, [DEFAULT_ISSUER]);
  assertEquals(prm.scopes_supported, ["vansen"]);
});
