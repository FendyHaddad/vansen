// The shared path of generate_image, upscale_image and vary_image: take a
// slot from the `mcp` budget, submit through the gateway service with the
// tool's Idempotency-Key, then wait up to 25 s for the worker and return
// the images — or the ids, with how to collect them. A replay says it
// charged nothing new. Entry: submitAndWait().
import { takeRequestSlot } from "../services/request-slots.ts";
import { gatewayFailure, mappedError, rateLimited } from "./errors.ts";
import { toolIdempotencyKey } from "./idempotency.ts";
import { imageBlocks } from "./images.ts";
import { ok } from "./results.ts";
import type { ToolCall, ToolEnv, ToolOutcome } from "./tool-kit.ts";
import { type GenerationItem, isSettled, itemView } from "./view.ts";

/** Under typical assistant tool timeouts, with room to build the answer. */
export const WAIT_BUDGET_MS = 25_000;
export const POLL_INTERVAL_MS = 1_500;
const MAX_POLLS = Math.ceil(WAIT_BUDGET_MS / POLL_INTERVAL_MS);

/** Poll the job reader until every item settles or the budget runs out. */
export async function waitForItems(
  env: ToolEnv,
  first: GenerationItem[],
): Promise<GenerationItem[]> {
  const ids = first.map((i) => String(i.id));
  const deadline = Date.now() + WAIT_BUDGET_MS;
  let items = first;
  for (let poll = 0; poll < MAX_POLLS && Date.now() < deadline; poll++) {
    if (items.every(isSettled)) return items;
    await env.sleep(POLL_INTERVAL_MS);
    const read = await env.ctx.readJobItems(env.userId, ids);
    // A failed read is not a failed job: answer with what we know.
    if ("error" in read) return items;
    items = read.items;
  }
  return items;
}

/** The closing sentence: what this call cost. A replay cost nothing new. */
function chargeSentence(charged: number, replay: boolean): string {
  if (replay) return "This request was already submitted, so nothing new charged.";
  return `${charged} credits charged for this request.`;
}

function summarize(items: GenerationItem[], charged: number, replay: boolean): string {
  const done = items.filter((i) => i.status === "done").length;
  const failed = items.filter((i) => i.status === "failed").length;
  const pending = items.length - done - failed;
  const parts = [];
  if (done) parts.push(`${done} image${done === 1 ? "" : "s"} ready`);
  if (failed) parts.push(`${failed} failed (credits refunded)`);
  if (pending) {
    parts.push(
      `${pending} still rendering after ${WAIT_BUDGET_MS / 1000} s — call get_generation with ${
        pending === 1 ? "its id" : "each id"
      } to collect ${pending === 1 ? "it" : "them"}`,
    );
  }
  const head = parts.length ? `${parts.join("; ")}. ` : "";
  return `${head}${chargeSentence(charged, replay)}`;
}

/** What a generate-type tool answers once the wait is over. */
export async function generationOutcome(
  env: ToolEnv,
  items: GenerationItem[],
  credits: unknown,
  replay = false,
): Promise<ToolOutcome> {
  const charged = items.reduce((sum, i) => sum + (Number(i.priceCredits) || 0), 0);
  const blocks = await imageBlocks(env, items);
  const outcome = items.every(isSettled) ? "ok" : "pending";
  return ok(summarize(items, charged, replay), { items: items.map(itemView), credits }, blocks, outcome);
}

export async function submitAndWait(
  env: ToolEnv,
  call: ToolCall,
  tool: string,
  args: Record<string, unknown>,
  submit: (idempotencyKey: string) => Promise<Response>,
): Promise<ToolOutcome> {
  const slot = await takeRequestSlot(env.ctx.admin, env.userId, "mcp");
  if ("unavailable" in slot) return mappedError("request_limit_unavailable", "");
  if (!slot.allowed) return rateLimited(slot.retryAfterSeconds);

  const { key, derived, replay } = await toolIdempotencyKey(env, call, tool, args);
  const res = await submit(key);
  if (!res.ok) return await gatewayFailure(res, { derivedKey: derived });
  const body = await res.json() as { items?: GenerationItem[]; credits?: unknown };
  const items = await waitForItems(env, body.items ?? []);
  return await generationOutcome(env, items, body.credits ?? null, replay);
}
