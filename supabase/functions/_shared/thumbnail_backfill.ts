// Thumbnails for everything made before migration 0022.
//
// The library grid downloads a tile-sized JPEG per row. Rows written before
// 0022 have no thumbnail at all, so the grid falls back to their originals —
// the exact egress this work exists to stop.
//
// Resumable (the claim lives in the database, not in this process),
// rate-limited (a backfill that saturates storage is an outage), and it never
// touches a row it did not claim: every write is keyed to an id that
// fn_claim_thumbnails handed over in this run.
import { canThumbnail, makeThumbnail, THUMB_CONTENT_TYPE, thumbPathFor } from "./thumbnail.ts";

export const DEFAULT_BATCH = 50;
export const DEFAULT_RPS = 4;
export const MAX_BATCH = 200;

// deno-lint-ignore no-explicit-any
type Admin = any;

export interface BackfillDeps {
  admin: Admin;
  /** Overridable so a test does not have to wait out the rate limit. */
  sleep?: (ms: number) => Promise<void>;
}

export interface BackfillOptions {
  batch?: number;
  max?: number;
  rps?: number;
}

export interface RowResult {
  id: string;
  state: "ready" | "failed" | "unsupported";
  path?: string;
  bytes?: number;
  reason?: string;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Reads flags without pulling in an argument parser. */
export function parseArgs(argv: string[]): Required<BackfillOptions> & { json: boolean } {
  const value = (name: string, fallback: number) => {
    const at = argv.indexOf(`--${name}`);
    if (at < 0) return fallback;
    const raw = Number(argv[at + 1]);
    return Number.isFinite(raw) && raw > 0 ? raw : fallback;
  };
  return {
    batch: Math.min(value("batch", DEFAULT_BATCH), MAX_BATCH),
    max: value("max", Number.POSITIVE_INFINITY),
    rps: value("rps", DEFAULT_RPS),
    json: argv.includes("--json"),
  };
}

async function record(
  admin: Admin,
  id: string,
  state: "failed" | "unsupported",
): Promise<void> {
  await admin.rpc("fn_set_thumbnail", {
    p_generation: id,
    p_path: null,
    p_state: state,
  });
}

/**
 * One row: read the original, make the tile, upload it, record it.
 *
 * Every outcome is written back. A row left `claimed` would be released an
 * hour later and fail again forever; saying "failed" out loud is how the next
 * run knows to stop trying.
 */
export async function backfillOne(
  deps: BackfillDeps,
  row: { id: string; media_path: string },
): Promise<RowResult> {
  const { admin } = deps;
  const { data: blob, error: readError } = await admin.storage
    .from("media")
    .download(row.media_path);
  if (readError || !blob) {
    await record(admin, row.id, "failed");
    return {
      id: row.id,
      state: "failed",
      reason: readError?.message ?? "no object",
    };
  }

  const contentType = blob.type || "image/png";
  if (!canThumbnail(contentType)) {
    await record(admin, row.id, "unsupported");
    return { id: row.id, state: "unsupported", reason: contentType };
  }

  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const thumb = await makeThumbnail(bytes, contentType);
    const path = thumbPathFor(row.media_path);
    const { error: writeError } = await admin.storage
      .from("media")
      .upload(path, thumb, { contentType: THUMB_CONTENT_TYPE, upsert: true });
    if (writeError) throw new Error(writeError.message);
    // Registers the object AND marks the row ready, in that order: an
    // unregistered thumbnail reads as an orphan to the inventory (P6).
    const { error: recordError } = await admin.rpc("fn_record_thumbnail", {
      p_generation: row.id,
      p_path: path,
    });
    if (recordError) throw new Error(recordError.message);
    return { id: row.id, state: "ready", path, bytes: thumb.length };
  } catch (e) {
    await record(admin, row.id, "failed");
    return { id: row.id, state: "failed", reason: String(e).slice(0, 200) };
  }
}

export interface BackfillSummary {
  processed: number;
  ready: number;
  failed: number;
  unsupported: number;
  results: RowResult[];
}

/** Claims and processes batches until the queue empties or `max` is reached. */
export async function runBackfill(
  deps: BackfillDeps,
  opts: BackfillOptions = {},
): Promise<BackfillSummary> {
  const batch = Math.min(opts.batch ?? DEFAULT_BATCH, MAX_BATCH);
  const max = opts.max ?? Number.POSITIVE_INFINITY;
  const rps = opts.rps ?? DEFAULT_RPS;
  const pause = deps.sleep ?? wait;
  const results: RowResult[] = [];

  while (results.length < max) {
    const want = Math.min(batch, max - results.length);
    const { data, error } = await deps.admin.rpc("fn_claim_thumbnails", {
      p_limit: want,
    });
    if (error) throw new Error(`claim_failed: ${error.message}`);
    const rows = (data ?? []) as { id: string; media_path: string }[];
    if (rows.length === 0) break;

    for (const row of rows) {
      results.push(await backfillOne(deps, row));
      // Storage is shared with live traffic: one image per 1/rps seconds.
      await pause(1000 / rps);
    }
  }

  return {
    processed: results.length,
    ready: results.filter((r) => r.state === "ready").length,
    failed: results.filter((r) => r.state === "failed").length,
    unsupported: results.filter((r) => r.state === "unsupported").length,
    results,
  };
}
