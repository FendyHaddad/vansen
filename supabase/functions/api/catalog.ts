// GET /catalog — what every app renders: the model families, their options,
// every valid combination with its price, and the fixed-price items. Public
// and unauthenticated like /capabilities: prices are on the pricing page
// anyway, and the app needs them before sign-in.
import type { Context } from "jsr:@hono/hono";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { buildCatalog, type ModelRow } from "./_shared/build-catalog.ts";
import { CATALOG_VERSION } from "./_shared/model-families.ts";

export const CATALOG_CACHE_CONTROL = "public, max-age=300";

export function modelRows(data: unknown): ModelRow[] {
  if (!Array.isArray(data)) return [];
  return data.map((row) => ({
    id: String(row.id),
    enabled: row.enabled === true,
    min_plan: typeof row.min_plan === "string" ? row.min_plan : null,
  }));
}

function hash31(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (Math.imul(hash, 31) + text.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** The catalog text only changes with CATALOG_VERSION; the rows are the rest. */
export function catalogEtag(rows: ModelRow[]): string {
  const flags = rows
    .map((row) => `${row.id}:${row.enabled}:${row.min_plan ?? ""}`)
    .sort()
    .join("|");
  return `"${CATALOG_VERSION}-${hash31(flags)}"`;
}

export function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header
    .split(",")
    .map((tag) => tag.trim().replace(/^W\//, ""))
    .some((tag) => tag === etag || tag === "*");
}

/** The gateway's app_errors writer, so a 503's errorId finds its row. */
export type CatalogErrorLog = (c: Context, code: string, err: unknown) => void;

export function catalogHandler(admin: SupabaseClient, logError: CatalogErrorLog) {
  return async (c: Context): Promise<Response> => {
    const { data, error } = await admin.from("models").select("id,enabled,min_plan");
    if (error) {
      logError(c, "catalog_unavailable", new Error(error.message));
      return c.json({
        error: {
          code: "catalog_unavailable",
          message: "Could not read the model catalog.",
          errorId: c.get("requestId") ?? "",
        },
      }, 503);
    }
    const rows = modelRows(data);
    const etag = catalogEtag(rows);
    c.header("ETag", etag);
    c.header("Cache-Control", CATALOG_CACHE_CONTROL);
    if (etagMatches(c.req.header("if-none-match"), etag)) return c.body(null, 304);
    return c.json(buildCatalog(rows));
  };
}

export const CATALOG_STALE = {
  code: "catalog_stale",
  message: "The model options changed. Pick again.",
} as const;

/** A client that told us its catalog, and it is not ours. */
export function isStaleCatalog(sent: unknown): boolean {
  if (typeof sent !== "string") return false;
  if (sent.length === 0) return false;
  return sent !== CATALOG_VERSION;
}
