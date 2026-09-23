// Signed media URLs, memoised per app instance.
// createMediaSigning(deps) returns browserUrl (the staging origin rewrite),
// signMedia (Supabase `media` bucket, 7-day URLs re-signed once under a day
// is left) and signStored (R2 paths go through the R2 adapter instead).
import type { StorageBackend } from "../_shared/storage/index.ts";
import type { ApiDeps } from "../lib/deps.ts";

export function createMediaSigning(deps: ApiDeps) {
  const { admin, storageFor } = deps;

  /** A signed storage URL the browser can open. Only applied to URLs meant
   * for the browser: a provider needs the URL as storage signed it, and no
   * origin makes a laptop reachable from a provider anyway. */
  function browserUrl(signed: string): string {
    const origin = deps.env.mediaPublicOrigin?.replace(/\/$/, '');
    if (!origin) return signed;
    if (!signed) return signed;
    const parsed = new URL(signed);
    return `${origin}${parsed.pathname}${parsed.search}`;
  }

  /** Warm-isolate memo so list reloads don't re-sign every media path, and the
   * URL stays stable across requests (lets browser HTTP caching work too). */
  const signedUrlMemo = new Map<string, { url: string; expiresAt: number }>();
  const SIGN_TTL_S = 604800; // 7 days
  const RESIGN_FLOOR_MS = 86_400_000; // re-sign when under 1 day of validity left

  async function signMedia(path: string | null): Promise<string> {
    if (!path) return "";
    const hit = signedUrlMemo.get(path);
    if (hit && hit.expiresAt - Date.now() > RESIGN_FLOOR_MS) return hit.url;
    const { data } = await admin.storage.from("media").createSignedUrl(
      path,
      SIGN_TTL_S,
    );
    if (!data?.signedUrl) return "";
    const url = browserUrl(data.signedUrl);
    if (signedUrlMemo.size > 5000) signedUrlMemo.clear();
    signedUrlMemo.set(path, {
      url,
      expiresAt: Date.now() + SIGN_TTL_S * 1000,
    });
    return url;
  }

  const r2SignMemo = new Map<string, { url: string; exp: number }>();

  /** Video media lives in R2, not the Supabase `media` bucket — sign through the
   * right backend. R2 URLs are memoized separately since signMedia's memo is
   * keyed to Supabase's own createSignedUrl call. */
  async function signStored(
    backend: StorageBackend,
    path: string | null,
    ttlS = SIGN_TTL_S,
  ): Promise<string> {
    if (!path) return "";
    if (backend !== "r2") return signMedia(path);
    const memoKey = `${path}|${ttlS}`;
    const hit = r2SignMemo.get(memoKey);
    if (hit && hit.exp > Date.now()) return hit.url;
    const url = await storageFor("r2").signedUrl(path, ttlS);
    if (r2SignMemo.size > 5000) r2SignMemo.clear();
    r2SignMemo.set(memoKey, { url, exp: Date.now() + (ttlS - 60) * 1000 });
    return url;
  }

  return { browserUrl, signMedia, signStored };
}

export type SignStored = ReturnType<typeof createMediaSigning>["signStored"];
