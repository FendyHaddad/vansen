// list_recent: the newest library items (id, prompt, model, status and a
// thumbnail link), through the same page reader as GET /generations.
import { z } from "npm:zod@4";
import { ok, toolError } from "../results.ts";
import { defineTool } from "../tool-kit.ts";

export const listRecent = defineTool({
  name: "list_recent",
  title: "Recent images",
  description: "The newest items in the user's Vansen library, newest first: id, prompt, model, status and a thumbnail link. Read-only.",
  inputSchema: {
    limit: z.number().int().min(1).max(20).optional().describe("How many (1–20, default 10)."),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  ageGated: true,
  async run(env, args) {
    const read = await env.ctx.libraryPage(env.userId, args.limit ?? 10, null);
    if ("error" in read) {
      return toolError("library_unavailable", "Vansen couldn't read the library.", "Try again in a moment.");
    }
    const dtos = await env.ctx.toGenerationDtos(read.rows, new Map(), { thumbsOnly: true });
    const items = dtos.map((d) => ({
      id: d.id,
      prompt: d.prompt,
      model: d.familyName,
      status: d.status,
      createdAt: d.createdAt,
      thumbnailUrl: d.thumbUrl ?? (d.mediaUrl || null),
    }));
    return ok(`${items.length} recent item${items.length === 1 ? "" : "s"}.`, { items });
  },
});
