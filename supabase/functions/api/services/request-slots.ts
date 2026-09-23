// The shared per-user request budgets (fn_take_request_slot, 0028 + 0035).
// takeRequestSlot() is the one caller: the HTTP middleware for the app's
// `generation`/`upload` buckets, and the MCP tools for the `mcp` bucket.
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

export type RequestBucket = "generation" | "upload" | "mcp";

export type SlotOutcome =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number }
  | { unavailable: true };

export async function takeRequestSlot(
  admin: SupabaseClient,
  userId: string,
  bucket: RequestBucket,
): Promise<SlotOutcome> {
  const { data, error } = await admin.rpc("fn_take_request_slot", {
    p_user: userId,
    p_bucket: bucket,
  });
  if (error || !data) return { unavailable: true };
  if (data.allowed) return { allowed: true };
  return { allowed: false, retryAfterSeconds: Number(data.retryAfterSeconds) || 60 };
}
