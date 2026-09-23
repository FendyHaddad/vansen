// get_account: plan, entitlement and credits (plan and pack buckets), read
// with the same services /profile uses. Not age-gated, like GET /profile.
import { isEntitled } from "../../services/entitlement.ts";
import { BILLING_URL, ok } from "../results.ts";
import { defineTool } from "../tool-kit.ts";

export const getAccount = defineTool({
  name: "get_account",
  title: "Vansen account",
  description:
    "The connected Vansen account: its plan (studio, pro), whether it is active, and the credit balance (1 credit = $0.01). Read-only.",
  inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: false },
  ageGated: false,
  async run(env) {
    const { admin, creditsOf } = env.ctx;
    const [credits, { data: sub }] = await Promise.all([
      creditsOf(env.userId),
      admin.from("subscriptions").select("plan,status,current_period_end")
        .eq("user_id", env.userId).maybeSingle(),
    ]);
    const entitled = isEntitled(sub, Date.now());
    const total = credits.plan + credits.pack;
    const data = {
      plan: sub?.plan ?? null,
      status: sub?.status ?? null,
      entitled,
      currentPeriodEnd: sub?.current_period_end ?? null,
      credits: { plan: credits.plan, pack: credits.pack, total },
    };
    const planLine = entitled
      ? `${String(sub?.plan)} plan, active.`
      : `No active plan — generating needs one (subscribe at ${BILLING_URL}).`;
    return ok(`${planLine} ${total} credits (${credits.plan} plan + ${credits.pack} pack).`, data);
  },
});
