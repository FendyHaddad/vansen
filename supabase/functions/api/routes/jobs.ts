// Job status and cancellation: GET /jobs (read-only; the worker drives
// every job) and POST /jobs/:id/cancel (a durable request the worker acts
// on; only work that never left the building is refunded here).
import { settleFailed } from "../_shared/jobs/settlement.ts";
import {
  type JobRow,
  NOT_CANCELLABLE,
} from "../services/generation-dto.ts";
import type { ApiContext, App } from "../lib/context.ts";
import { fail } from "../lib/http.ts";

export function registerJobRoutes(app: App, ctx: ApiContext): void {
  const { admin, creditsOf, logError, toGenerationDtos } = ctx;

  app.get("/jobs", async (c) => {
    const userId = c.get("userId");
    const idsParam = c.req.query("ids") ?? "";
    const ids = idsParam.split(",").map((s) => s.trim()).filter(Boolean).slice(
      0,
      20,
    );
    if (ids.length === 0) return c.json({ items: [] });

    // Read-only. Progress used to be produced by polling providers from inside
    // this request, which meant a closed tab stranded the job until a timeout
    // refunded it. The worker drives every job now; this only reports.
    // An empty list on a failed read tells the client its pending work
    // vanished, so it stops watching. A failure has to say it failed.
    const jobsUnavailable = (error: { message: string }) => {
      logError(c, "jobs_read_failed", new Error(error.message));
      return fail(c, 503, "jobs_unavailable", "Could not check your jobs. Try again.");
    };
    const { data: freshJobs, error: jobsError } = await admin
      .from("jobs")
      .select(
        "id,generation_id,progress,phase,claimed_at,created_at,queue_position",
      )
      .eq("user_id", userId)
      .in("generation_id", ids);
    if (jobsError) return jobsUnavailable(jobsError);
    const jobsByGen = new Map<string, JobRow>(
      (freshJobs ?? []).map((j) => [j.generation_id, j as JobRow]),
    );
    const { data: gens, error: gensError } = await admin.from("generations")
      .select("*").eq("user_id", userId).in("id", ids).is("deleted_at", null);
    if (gensError) return jobsUnavailable(gensError);
    return c.json({ items: await toGenerationDtos(gens ?? [], jobsByGen) });
  });

  app.post("/jobs/:id/cancel", async (c) => {
    const userId = c.get("userId") as string;
    const generationId = c.req.param("id");
    const { data: gen } = await admin
      .from("generations")
      .select("id,status,family_id,price_credits,kind")
      .eq("id", generationId)
      .eq("user_id", userId)
      .is("deleted_at", null)
      .maybeSingle();
    if (!gen) return fail(c, 404, "not_found", "Generation not found.");
    if (gen.status !== "pending") {
      return fail(c, 409, "not_pending", "Already finished.");
    }
    if (NOT_CANCELLABLE.has(gen.family_id)) {
      return fail(
        c,
        409,
        "not_cancellable",
        "This model can't be cancelled once started.",
      );
    }
    const { data: job } = await admin
      .from("jobs")
      .select("id,state,provider_ref,lease_token")
      .eq("generation_id", generationId)
      .is("error", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!job) return fail(c, 404, "not_found", "Job not found.");

    // Cancellation is a durable request, not an action. The worker owns the
    // provider conversation, and only a provider that confirms it stopped
    // earns a refund — the route cannot know that from here.
    const { error: markError } = await admin
      .from("jobs")
      .update({ cancel_requested_at: new Date().toISOString(), next_run_at: new Date().toISOString() })
      .eq("id", job.id);
    if (markError) {
      return fail(
        c,
        503,
        "cancel_failed",
        "Could not record your cancellation. Try again.",
      );
    }

    // Work that never left the building is different: nothing is running and
    // nothing is billing us, so it can be refunded here and now.
    const untouched = job.state === "ready" && !job.lease_token &&
      !job.provider_ref;
    if (!untouched) {
      return c.json({
        cancelling: true,
        refundedCredits: 0,
        credits: await creditsOf(userId),
      }, 202);
    }

    const settled = await settleFailed(admin, job.id, "cancelled");
    if (!settled.settled) {
      return c.json({
        cancelling: true,
        refundedCredits: 0,
        credits: await creditsOf(userId),
      }, 202);
    }
    return c.json({
      refundedCredits: settled.refunded,
      credits: await creditsOf(userId),
    });
  });
}
