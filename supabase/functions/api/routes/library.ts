// Library reads: GET /generations (the paged grid, thumbnails only),
// GET /generations/:id (one item, fully signed) and
// GET /generations/:id/versions (its version chain, oldest first).
// Tombstoned rows (deleted_at set) are never returned.
import type { ApiContext, App } from "../lib/context.ts";
import { fail } from "../lib/http.ts";
import {
  decodeCursor,
  encodeCursor,
  MAX_PAGE,
  pageSize,
  versionChain,
} from "../lib/paging.ts";

export function registerLibraryReadRoutes(app: App, ctx: ApiContext): void {
  const { admin, libraryPage, toGenerationDto, toGenerationDtos } = ctx;

  app.get("/generations", async (c) => {
    const userId = c.get("userId") as string;
    const limit = pageSize(c.req.query("limit"));
    const rawCursor = c.req.query("cursor");
    const cursor = rawCursor ? decodeCursor(rawCursor) : null;
    if (rawCursor && !cursor) {
      return fail(c, 400, "invalid_cursor", "That page marker is not valid.");
    }

    const read = await libraryPage(userId, limit, cursor);
    if ("error" in read) return fail(c, 400, "query_failed", read.error);

    const { rows: page, hasMore } = read;
    return c.json({
      items: await toGenerationDtos(page, new Map(), { thumbsOnly: true }),
      nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
    });
  });

  /**
   * One item, fully signed. The library is paged now, so an item the client
   * wants — a deep link, an edit parent — may never have been in a loaded page.
   */
  app.get("/generations/:id", async (c) => {
    const { data } = await admin
      .from("generations")
      .select("*")
      .eq("id", c.req.param("id"))
      .eq("user_id", c.get("userId") as string)
      .is("deleted_at", null)
      .maybeSingle();
    if (!data) return fail(c, 404, "not_found", "That item does not exist.");
    return c.json({ item: await toGenerationDto(data) });
  });

  /**
   * The version chain rooted at one item, oldest first. The client used to
   * assemble this from whatever happened to be loaded, which silently lost
   * ancestors once the library paged.
   */
  app.get("/generations/:id/versions", async (c) => {
    const userId = c.get("userId") as string;
    const limit = pageSize(c.req.query("limit"));
    const rawCursor = c.req.query("cursor");
    const cursor = rawCursor ? decodeCursor(rawCursor) : null;
    if (rawCursor && !cursor) {
      return fail(c, 400, "invalid_cursor", "That page marker is not valid.");
    }

    const { data: root } = await admin
      .from("generations")
      .select("*")
      .eq("id", c.req.param("id"))
      .eq("user_id", userId)
      .is("deleted_at", null)
      .maybeSingle();
    if (!root) return fail(c, 404, "not_found", "That item does not exist.");

    const { data, error } = await admin
      .from("generations")
      .select("*")
      .eq("user_id", userId)
      .is("deleted_at", null)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(MAX_PAGE * 4);
    if (error) return fail(c, 400, "query_failed", error.message);

    const chain = versionChain((data ?? []) as Record<string, unknown>[], root);
    const start = cursor
      ? chain.findIndex((r) => String(r.id) === cursor.id) + 1
      : 0;
    const page = chain.slice(start, start + limit);
    const hasMore = start + limit < chain.length;
    return c.json({
      items: await toGenerationDtos(page),
      nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
    });
  });
}
