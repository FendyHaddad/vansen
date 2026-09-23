// The library's newest-first keyset page over `generations`, shared by
// GET /generations and the MCP list_recent tool. Tombstoned rows are never
// returned. Entry: createLibrary(services).libraryPage().
import type { Services } from "../lib/context.ts";

export function createLibrary(ctx: Pick<Services, "admin">) {
  const { admin } = ctx;

  /** One page plus "is there more?" (one extra row is read to tell). */
  async function libraryPage(
    userId: string,
    limit: number,
    cursor: { createdAt: string; id: string } | null,
  ): Promise<{ rows: Record<string, unknown>[]; hasMore: boolean } | { error: string }> {
    let query = admin
      .from("generations")
      .select("*")
      .eq("user_id", userId)
      // A tombstoned row is gone as far as its owner is concerned; it exists
      // only until its job settles and the cleanup worker has its bytes.
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit + 1);
    if (cursor) {
      query = query.or(
        `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`,
      );
    }
    const { data, error } = await query;
    if (error) return { error: error.message };
    const rows = (data ?? []) as Record<string, unknown>[];
    const hasMore = rows.length > limit;
    return { rows: hasMore ? rows.slice(0, limit) : rows, hasMore };
  }

  return { libraryPage };
}
