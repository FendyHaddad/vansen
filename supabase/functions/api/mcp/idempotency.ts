// The Idempotency-Key every generate-type tool sends (spec §4). The caller's
// idempotency_key if given, otherwise one derived from the JSON-RPC request
// id, the arguments and a 120 s time bucket; either way namespaced by user,
// grant and tool, and hashed into the UUID shape fn_reserve_generation takes.
// toolIdempotencyKey() also says whether the key was already submitted.
import { canonicalJson } from "../services/idempotency.ts";
import type { ToolCall, ToolEnv } from "./tool-kit.ts";

/** How long a derived key stays a retry. Later, the same call is new work. */
export const RETRY_WINDOW_MS = 120_000;

export interface ToolKey {
  key: string;
  /** True when the caller gave no idempotency_key and we derived one. */
  derived: boolean;
  /** True when this key already has a submission: the call replays it. */
  replay: boolean;
}

async function uuidOf(material: string): Promise<string> {
  const bytes = new TextEncoder().encode(material);
  const hex = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  // Version 5 and the RFC 4122 variant, so the gateway's UUID check accepts it.
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The first of `keys` (in order) that already has a submission, or null. A
 * failed read answers null: the call then takes the current key, and the
 * RPC's own replay check still stops a double charge within the bucket.
 */
async function submittedKey(env: ToolEnv, keys: string[]): Promise<string | null> {
  const { data, error } = await env.ctx.admin
    .from("submissions")
    .select("idempotency_key")
    .eq("user_id", env.userId)
    .in("idempotency_key", keys);
  if (error || !data) return null;
  const found = new Set((data as { idempotency_key: string }[]).map((r) => r.idempotency_key));
  return keys.find((k) => found.has(k)) ?? null;
}

/**
 * Why the arguments are in the derived key: stateless clients restart their
 * request ids (a new chat can send id 3 again). Why the time bucket: a retry
 * of a timed-out call lands within seconds, while the same request minutes
 * or days later is a deliberate re-run. A match in the current or previous
 * bucket replays, so a retry that straddles a bucket edge still does.
 */
export async function toolIdempotencyKey(
  env: ToolEnv,
  call: ToolCall,
  tool: string,
  args: Record<string, unknown>,
): Promise<ToolKey> {
  const { idempotency_key: callerKey, ...rest } = args;
  const scope = `${env.userId}|${env.clientId}|${tool}`;
  if (typeof callerKey === "string" && callerKey) {
    const key = await uuidOf(`${scope}|key|${callerKey}`);
    return { key, derived: false, replay: (await submittedKey(env, [key])) !== null };
  }
  const bucket = Math.floor(env.ctx.deps.now().getTime() / RETRY_WINDOW_MS);
  const material = (b: number) => `${scope}|rpc|${String(call.rpcId)}|${b}|${canonicalJson(rest)}`;
  const current = await uuidOf(material(bucket));
  const previous = await uuidOf(material(bucket - 1));
  const found = await submittedKey(env, [current, previous]);
  return { key: found ?? current, derived: true, replay: found !== null };
}
