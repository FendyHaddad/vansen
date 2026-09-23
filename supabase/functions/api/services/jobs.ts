// Job status reads and cancellation, shared by GET /jobs, POST /jobs/:id/cancel
// and the MCP tools. readJobItems() is read-only (the worker drives every
// job); cancelGeneration() records a durable cancel request and refunds only
// work that never left the building. Entry: createJobs(services).
import type { Context } from "jsr:@hono/hono";
import { settleFailed } from "../_shared/jobs/settlement.ts";
import { type JobRow, NOT_CANCELLABLE } from "./generation-dto.ts";
import type { Services } from "../lib/context.ts";
import { fail } from "../lib/http.ts";

export type JobItems = Awaited<ReturnType<Services["toGenerationDtos"]>>;

export function createJobs(
  ctx: Pick<Services, "admin" | "creditsOf" | "toGenerationDtos">,
) {
  const { admin, creditsOf, toGenerationDtos } = ctx;

  /**
   * The user's generations with these ids, fully signed, with live job
   * progress. A failed read says so: an empty list would tell the client its
   * pending work vanished, so it would stop watching.
   */
  async function readJobItems(
    userId: string,
    ids: string[],
  ): Promise<{ items: JobItems } | { error: string }> {
    if (ids.length === 0) return { items: [] };
    const { data: freshJobs, error: jobsError } = await admin
      .from("jobs")
      .select(
        "id,generation_id,progress,phase,claimed_at,created_at,queue_position",
      )
      .eq("user_id", userId)
      .in("generation_id", ids);
    if (jobsError) return { error: jobsError.message };
    const jobsByGen = new Map<string, JobRow>(
      (freshJobs ?? []).map((j) => [j.generation_id, j as JobRow]),
    );
    const { data: gens, error: gensError } = await admin.from("generations")
      .select("*").eq("user_id", userId).in("id", ids).is("deleted_at", null);
    if (gensError) return { error: gensError.message };
    return { items: await toGenerationDtos(gens ?? [], jobsByGen) };
  }

  /** The cancel answer: 200 refunded, 202 cancelling, or a refusal. */
  async function cancelGeneration(c: Context, generationId: string): Promise<Response> {
    const userId = c.get("userId") as string;
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
    const cancelling = async () =>
      c.json({ cancelling: true, refundedCredits: 0, credits: await creditsOf(userId) }, 202);
    if (!untouched) return await cancelling();

    const settled = await settleFailed(admin, job.id, "cancelled");
    if (!settled.settled) return await cancelling();
    return c.json({
      refundedCredits: settled.refunded,
      credits: await creditsOf(userId),
    });
  }

  return { readJobItems, cancelGeneration };
}
