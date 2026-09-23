// GET /ledger: the caller's credit history, newest first, keyset-paged.
// A failed read is a 503 ledger_unavailable, never an empty history.
import type { ApiContext, App } from "../lib/context.ts";
import { fail } from "../lib/http.ts";
import { decodeCursor, encodeCursor, pageSize } from "../lib/paging.ts";

function toLedgerDto(row: Record<string, unknown>) {
  return {
    id: row.id,
    type: row.type,
    amountCredits: Number(row.amount_credits),
    bucket: row.bucket,
    familyId: row.family_id,
    note: row.note,
    createdAt: row.created_at,
  };
}

export function registerLedgerRoutes(app: App, ctx: ApiContext): void {
  const { admin, logError } = ctx;

  app.get("/ledger", async (c) => {
    const limit = pageSize(c.req.query("limit"));
    const rawCursor = c.req.query("cursor");
    const cursor = rawCursor ? decodeCursor(rawCursor) : null;
    if (rawCursor && !cursor) {
      return fail(c, 400, "invalid_cursor", "That page marker is not valid.");
    }

    let query = admin
      .from("ledger_entries")
      .select("*")
      .eq("user_id", c.get("userId"))
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit + 1);
    if (cursor) {
      query = query.or(
        `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`,
      );
    }

    const { data, error } = await query;
    if (error) {
      logError(c, "ledger_read_failed", new Error(error.message));
      return fail(c, 503, "ledger_unavailable", "Could not load your usage. Try again.");
    }

    // The old `.limit(100)` was not a page, it was a truncation: an account
    // with more history than that could never see its oldest charges.
    const rows = (data ?? []) as Record<string, unknown>[];
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return c.json({
      entries: page.map(toLedgerDto),
      nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
    });
  });
}
