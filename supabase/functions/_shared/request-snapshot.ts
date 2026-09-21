// What the customer actually asked for, recorded once at submission.
//
// Retry used to be assembled by the client from whatever it still had in
// memory: family, op, prompt, settings, parent. A mask was gone, a video's
// references were gone, a persona item carried the pseudo-family "persona".
// This module is the opposite discipline — every field is listed by name, so
// nothing can be smuggled in and nothing can be forgotten.
//
// Two rules the tests enforce and the type system cannot:
//   1. Identities, never URLs. A signed URL expires in 7 days; a snapshot is
//      read weeks later.
//   2. No spread. `{...request}` is exactly how a signed URL, a megabyte data
//      URI or a stale price ends up persisted.
import type { GenerationOp } from './enums.ts';
import type { GenerationSettings, VideoMode } from './model-families.ts';

export const SNAPSHOT_VERSION = 1;

/** The three roles a video reference can play. Positions are not roles. */
export interface ReferenceSlots {
  first: string | null;
  last: string | null;
  references: string[];
}

export interface GenerationRequestSnapshotV1 {
  version: 1;
  op: GenerationOp;
  familyId: string;
  prompt: string;
  settings: GenerationSettings;
  /** Owned identities, never signed URLs — those expire in 7 days. */
  referenceUploadIds: string[];
  referenceSlots: ReferenceSlots;
  maskUploadId: string | null;
  personaId: string | null;
  styleId: string | null;
  trendId: string | null;
  mode: VideoMode | null;
  parentId: string | null;
  catalogVersion: string;
  quoteVersion: number;
}

export type RehydrateReason =
  | 'unsupported_version'
  | 'catalog_changed'
  | 'missing_reference'
  | 'missing_mask';

export type RehydrateResult =
  | { ok: true; request: GenerationRequestSnapshotV1 }
  | { ok: false; reason: RehydrateReason };

/** Only the axes the catalog defines. A settings bag is not a free-form store. */
function copySettings(settings: GenerationSettings): GenerationSettings {
  const copy: GenerationSettings = { aspectRatio: settings.aspectRatio };
  if (settings.version !== undefined) copy.version = settings.version;
  if (settings.resolution !== undefined) copy.resolution = settings.resolution;
  if (settings.quality !== undefined) copy.quality = settings.quality;
  if (settings.durationS !== undefined) copy.durationS = settings.durationS;
  if (settings.audio !== undefined) copy.audio = settings.audio;
  if (settings.batch !== undefined) copy.batch = settings.batch;
  return copy;
}

/**
 * Field by field, deliberately. Extra properties on the input are dropped
 * rather than carried, which is the point: callers hand this whole normalized
 * requests that also hold signed URLs and mask data URIs.
 */
export function captureSnapshot(
  input: Omit<GenerationRequestSnapshotV1, 'version'>,
): GenerationRequestSnapshotV1 {
  return {
    version: SNAPSHOT_VERSION,
    op: input.op,
    familyId: input.familyId,
    prompt: input.prompt,
    settings: copySettings(input.settings),
    referenceUploadIds: [...input.referenceUploadIds],
    referenceSlots: {
      first: input.referenceSlots.first,
      last: input.referenceSlots.last,
      references: [...input.referenceSlots.references],
    },
    maskUploadId: input.maskUploadId,
    personaId: input.personaId,
    styleId: input.styleId,
    trendId: input.trendId,
    mode: input.mode,
    parentId: input.parentId,
    catalogVersion: input.catalogVersion,
    quoteVersion: input.quoteVersion,
  };
}

/**
 * Decide whether a stored snapshot can still be replayed.
 *
 * `currentCatalogVersion` is optional so a caller with no opinion can skip the
 * check; the gateway always passes it. A catalog change means a price or a
 * provider model moved — replaying at the new price is a surprise charge and
 * replaying at the old one is a loss, so neither happens silently.
 */
export function rehydrate(
  snapshot: GenerationRequestSnapshotV1,
  currentCatalogVersion?: string,
): RehydrateResult {
  if (snapshot.version !== SNAPSHOT_VERSION) {
    return { ok: false, reason: 'unsupported_version' };
  }
  if (currentCatalogVersion && snapshot.catalogVersion !== currentCatalogVersion) {
    return { ok: false, reason: 'catalog_changed' };
  }
  // A stored snapshot is data read back out of a database, not a value this
  // process built. Rows written before a field existed, or by an older
  // version of the gateway, are missing it — and a retry crashing on one is
  // worse than a retry that treats it as empty.
  return {
    ok: true,
    request: captureSnapshot({
      ...snapshot,
      settings: snapshot.settings ?? { aspectRatio: '1:1' },
      referenceUploadIds: snapshot.referenceUploadIds ?? [],
      referenceSlots: {
        first: snapshot.referenceSlots?.first ?? null,
        last: snapshot.referenceSlots?.last ?? null,
        references: snapshot.referenceSlots?.references ?? [],
      },
      maskUploadId: snapshot.maskUploadId ?? null,
      personaId: snapshot.personaId ?? null,
      styleId: snapshot.styleId ?? null,
      trendId: snapshot.trendId ?? null,
      mode: snapshot.mode ?? null,
      parentId: snapshot.parentId ?? null,
    }),
  };
}
