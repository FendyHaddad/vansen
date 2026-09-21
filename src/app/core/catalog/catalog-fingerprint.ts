/**
 * The measured shape of the catalog at the recorded CATALOG_VERSION.
 *
 * `catalog-version.spec.ts` recomputes this from MODEL_FAMILIES and fails when
 * the two disagree, so a catalog change that forgets a version bump — and with
 * it the Deno `_shared` copy and the Flutter fixture — is a red test on the
 * machine that caused it rather than a silent divergence between three repos.
 *
 * To update: change the catalog, bump CATALOG_VERSION, run `npm run
 * sync-shared` and `npm run export-catalog`, hand the new Dart fixture to the
 * mobile repo, then paste the new fingerprint here.
 */
export const recordedCatalogFingerprint = '-43a774f1';
