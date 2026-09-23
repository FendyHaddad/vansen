/**
 * The measured shape of the catalog at the recorded CATALOG_VERSION.
 *
 * `catalog-version.spec.ts` recomputes this from MODEL_FAMILIES and fails when
 * the two disagree, so a catalog change that forgets a version bump — and with
 * it the Deno `_shared` copy and every client's `catalog_stale` signal — is a
 * red test on the machine that caused it.
 *
 * To update: change the catalog, bump CATALOG_VERSION, run `npm run
 * sync-shared`, regenerate mobile's bundled copy with `npm run catalog:mobile
 * <path>`, then paste the new fingerprint here.
 */
export const recordedCatalogFingerprint = '3c74b4fc';
