// The generation DTO every library, job and submit response returns.
// jobDto() and failureDto() are pure; createGenerationDtos(signStored)
// returns toGenerationDto(s), which sign media (the thumbnail only, in the
// list shape). NOT_CANCELLABLE names families that cannot stop once started.
import {
  familyById,
  type GenerationSettings,
} from "../_shared/model-families.ts";
import { MediaKind } from "../_shared/enums.ts";
import type { StorageBackend } from "../_shared/storage/index.ts";
import { expectedSecondsFor } from "../_shared/video-rules.ts";
import type { SignStored } from "./media-signing.ts";

export type JobRow = {
  id: string;
  generation_id: string;
  progress: number | null;
  phase: string | null;
  claimed_at: string | null;
  created_at: string;
  queue_position: number | null;
};

export const NOT_CANCELLABLE = new Set(["veo", "omni"]);

function jobDto(row: Record<string, unknown>, job: JobRow | undefined) {
  if (!job || row.status !== "pending") return undefined;
  const family = familyById(String(row.family_id));
  const settings = (row.settings ?? {}) as GenerationSettings;
  return {
    progress: job.progress ?? undefined,
    phase: (job.claimed_at ? "saving" : job.phase ?? "queued") as
      | "queued"
      | "rendering"
      | "saving",
    cancellable: !NOT_CANCELLABLE.has(String(row.family_id)),
    expectedS: family ? expectedSecondsFor(family, settings.durationS) : 30,
    startedAt: job.created_at,
    queuePosition: job.queue_position ?? undefined,
  };
}

const FAILURE_CODES = new Set([
  "cancelled",
  "moderation",
  "provider_error",
  "timeout",
  "store_failed",
  "generation_failed",
]);

/**
 * The safe, stable reason a generation ended badly.
 *
 * P4 persists it, so a reload sees the same thing the live client saw — a
 * cancelled video used to come back as "Generation failed · Retry" because
 * cancellation lived only in a client-side patch. The raw provider text
 * stays in `jobs.error` and never reaches a customer.
 */
function failureDto(row: Record<string, unknown>) {
  if (row.status !== "failed") return undefined;
  const raw = String(row.failure_code ?? "");
  const code = FAILURE_CODES.has(raw) ? raw : "generation_failed";
  const message = typeof row.failure_message === "string" && row.failure_message
    ? row.failure_message
    : "Generation failed. Your credits were refunded.";
  return {
    code: code as
      | "cancelled"
      | "moderation"
      | "provider_error"
      | "timeout"
      | "store_failed"
      | "generation_failed",
    message,
    cancelled: code === "cancelled",
  };
}

/** Options for the list shape; a grid needs a tile, not the original. */
interface DtoOpts {
  /** Sign the thumbnail only. Full media is signed when an item is opened. */
  thumbsOnly?: boolean;
}

export function createGenerationDtos(signStored: SignStored) {
  async function toGenerationDto(
    row: Record<string, unknown>,
    job?: JobRow,
    opts: DtoOpts = {},
  ) {
    const backend = (row.storage_backend ?? "supabase") as StorageBackend;
    const mediaPath = (row.media_path as string | null) ?? null;
    const thumbPath = (row.thumb_path as string | null) ?? null;
    // One signature per row in list shape. A row with no thumbnail yet
    // (everything made before 0022, and a video whose poster has not been
    // captured) signs its original instead, so the tile still renders and the
    // poster capture still has something to read.
    const listsMedia = opts.thumbsOnly && !thumbPath;
    return {
      id: row.id,
      kind: row.kind,
      familyId: row.family_id,
      familyName: row.family_name,
      op: row.op,
      prompt: row.prompt,
      settings: row.settings,
      priceCredits: Number(row.price_credits),
      status: row.status,
      mediaUrl: opts.thumbsOnly && !listsMedia
        ? ""
        : await signStored(backend, mediaPath),
      thumbUrl: thumbPath ? await signStored(backend, thumbPath) : undefined,
      storageBackend: row.kind === MediaKind.Video ? backend : undefined,
      durationS: row.duration_s == null ? undefined : Number(row.duration_s),
      parentId: row.parent_id,
      createdAt: row.created_at,
      job: jobDto(row, job),
      failure: failureDto(row),
    };
  }

  async function toGenerationDtos(
    rows: Record<string, unknown>[],
    jobs: Map<string, JobRow> = new Map(),
    opts: DtoOpts = {},
  ) {
    // Signing is independent per row; awaiting them in sequence made a
    // 200-row page 400 round trips deep.
    return Promise.all(
      rows.map((r) => toGenerationDto(r, jobs.get(String(r.id)), opts)),
    );
  }

  return { toGenerationDto, toGenerationDtos };
}
