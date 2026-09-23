// get_generation: one item's status and progress, the image when done, the
// reason when failed. Reads through the same job reader as GET /jobs.
import { z } from "npm:zod@4";
import { mappedError } from "../errors.ts";
import { imageBlocks } from "../images.ts";
import { ok, toolError } from "../results.ts";
import { defineTool } from "../tool-kit.ts";
import { itemView } from "../view.ts";

/** Generation ids are uuids; anything else cannot exist (and Postgres would
 * refuse it in the read as a type error, not answer "no rows"). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function summary(view: Record<string, unknown>): string {
  if (view.status === "done") return "The image is ready.";
  if (view.status === "failed") return `It failed: ${String(view.failure ?? "no reason recorded")}`;
  const progress = view.progress === undefined ? "" : ` (${String(view.progress)}%)`;
  return `Still rendering${progress}. Check again in a few seconds.`;
}

export const getGeneration = defineTool({
  name: "get_generation",
  title: "Check a generation",
  description:
    "Status of one Vansen generation by id: pending (with progress), done (with the image), or failed (with the reason; its credits were refunded). Read-only.",
  inputSchema: { id: z.string().min(1).max(64).describe("The generation id.") },
  annotations: { readOnlyHint: true, openWorldHint: false },
  ageGated: true,
  async run(env, args) {
    if (!UUID.test(args.id)) return mappedError("not_found", "");
    const read = await env.ctx.readJobItems(env.userId, [args.id]);
    if ("error" in read) {
      return toolError("jobs_unavailable", "Vansen couldn't check that generation.", "Try again in a moment.");
    }
    const item = read.items[0];
    if (!item) return mappedError("not_found", "");
    const view = itemView(item);
    return ok(summary(view), view, await imageBlocks(env, [item]));
  },
});
