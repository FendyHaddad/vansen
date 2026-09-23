// How a generation reads in a tool result: the fields an assistant needs to
// talk about it (id, status, model, prompt, price, progress or failure),
// taken from the gateway's generation DTO. Signed URLs stay out of the JSON;
// images travel as blocks (images.ts).
import type { JobItems } from "../services/jobs.ts";

export type GenerationItem = JobItems[number];

export function itemView(item: GenerationItem) {
  const view: Record<string, unknown> = {
    id: item.id,
    status: item.status,
    model: item.familyName,
    op: item.op,
    prompt: item.prompt,
    creditsCharged: item.priceCredits,
    createdAt: item.createdAt,
  };
  if (item.parentId) view.parentId = item.parentId;
  if (item.job) {
    view.phase = item.job.phase;
    if (item.job.progress !== undefined) view.progress = item.job.progress;
  }
  if (item.failure) view.failure = item.failure.message;
  return view;
}

export const isSettled = (item: GenerationItem) => item.status !== "pending";
