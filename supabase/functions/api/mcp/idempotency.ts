// The Idempotency-Key every generate-type tool sends (spec §4). The caller's
// idempotency_key if given, otherwise one derived from the JSON-RPC request
// id and the arguments; either way namespaced by user, grant and tool, and
// hashed into the UUID shape fn_reserve_generation's key column takes.
import { canonicalJson } from "../services/idempotency.ts";
import type { ToolCall, ToolEnv } from "./tool-kit.ts";

/**
 * Why the arguments are in the derived key: stateless clients restart their
 * request ids (a new chat can send id 3 again). Same id + same arguments is a
 * retry and replays; same id + different arguments is a new request.
 */
export async function toolIdempotencyKey(
  env: ToolEnv,
  call: ToolCall,
  tool: string,
  args: Record<string, unknown>,
): Promise<string> {
  const { idempotency_key: callerKey, ...rest } = args;
  const material = typeof callerKey === "string" && callerKey
    ? `key|${callerKey}`
    : `rpc|${String(call.rpcId)}|${canonicalJson(rest)}`;
  const bytes = new TextEncoder().encode(`${env.userId}|${env.clientId}|${tool}|${material}`);
  const hex = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  // Version 5 and the RFC 4122 variant, so the gateway's UUID check accepts it.
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
