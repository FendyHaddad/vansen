// Job status and cancellation: GET /jobs (read-only; the worker drives
// every job) and POST /jobs/:id/cancel (a durable request the worker acts
// on; only work that never left the building is refunded here). The bodies
// live in services/jobs.ts, shared with the MCP tools.
import type { ApiContext, App } from "../lib/context.ts";
import { fail } from "../lib/http.ts";

export function registerJobRoutes(app: App, ctx: ApiContext): void {
  const { cancelGeneration, logError, readJobItems } = ctx;

  app.get("/jobs", async (c) => {
    const idsParam = c.req.query("ids") ?? "";
    const ids = idsParam.split(",").map((s) => s.trim()).filter(Boolean).slice(
      0,
      20,
    );
    // Read-only. Progress used to be produced by polling providers from inside
    // this request, which meant a closed tab stranded the job until a timeout
    // refunded it. The worker drives every job now; this only reports.
    const read = await readJobItems(c.get("userId"), ids);
    if ("error" in read) {
      logError(c, "jobs_read_failed", new Error(read.error));
      return fail(c, 503, "jobs_unavailable", "Could not check your jobs. Try again.");
    }
    return c.json({ items: read.items });
  });

  app.post("/jobs/:id/cancel", (c) => cancelGeneration(c, c.req.param("id")));
}
