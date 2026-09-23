// The 18+ gate as a question: has this user confirmed an adult birth date?
// createAgeGate(admin, memo) returns ageConfirmed(userId). The HTTP
// middleware refuses on it; the MCP tools turn it into a tool error.
// The memo is safe: birth_date only ever goes unset → set.
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

export function createAgeGate(admin: SupabaseClient, ageOkMemo: Set<string>) {
  async function ageConfirmed(userId: string): Promise<boolean> {
    if (ageOkMemo.has(userId)) return true;
    const { data } = await admin
      .from("profiles")
      .select("birth_date")
      .eq("id", userId)
      .single();
    if (!data?.birth_date) return false;
    if (ageOkMemo.size > 10_000) ageOkMemo.clear();
    ageOkMemo.add(userId);
    return true;
  }
  return { ageConfirmed };
}
