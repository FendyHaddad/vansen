// Generation submission and replay: POST /generations, and
// POST /generations/:id/retry|variation plus GET /generations/:id/retryable,
// which rebuild the request from its snapshot (services/replay.ts) and
// re-enter submitGeneration (services/submit-generation.ts).
import type { ApiContext, App } from "../lib/context.ts";
import { fail } from "../lib/http.ts";

export function registerGenerationRoutes(app: App, ctx: ApiContext): void {
  const { submitGeneration, retryGeneration, varyGeneration, retryability } = ctx;

  app.post("/generations", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body) return fail(c, 400, "invalid_payload", "JSON body required");
    return await submitGeneration(c, body);
  });

  // Re-run what the customer actually asked for. The body is rebuilt on the
  // server and goes back through the normal submission path, so it is
  // re-validated, re-moderated, re-quoted at today's price and re-snapshotted.
  app.post("/generations/:id/retry", (c) => retryGeneration(c, c.req.param("id")));

  // Another take on the same prompt, hung off the original as its parent.
  app.post("/generations/:id/variation", (c) => varyGeneration(c, c.req.param("id")));

  // What the UI should enable. A disabled button with a reason is honest; a
  // button that always fails is not.
  app.get("/generations/:id/retryable", (c) => retryability(c, c.req.param("id")));
}
