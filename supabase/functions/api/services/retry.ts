// Retry and variation as server operations.
//
// The client used to rebuild the request from what it still had in memory,
// which was never the whole request: a mask retry failed "requires a mask", a
// video i2v retry failed "bad_reference_count", a persona item retried as the
// pseudo-family "persona" and failed "invalid_family". The server holds the
// snapshot, so the server rebuilds it — and where it genuinely cannot, it says
// so with a code the UI can render instead of letting the provider reject it.
import type { GenerationRequestSnapshotV1 } from '../_shared/request-snapshot.ts';
import { rehydrate } from '../_shared/request-snapshot.ts';

export type RetryRefusal =
  | 'not_retryable' // no snapshot (pre-0023 row)
  | 'not_variable' // the op has no meaningful variation
  | 'reference_unavailable' // an upload or mask was deleted
  | 'family_disabled' // kill switch is off for this family
  | 'catalog_changed' // the request can no longer be expressed
  | 'plan_required'; // entitlement lapsed since the original run

export const REFUSAL_MESSAGE: Record<RetryRefusal, string> = {
  not_retryable:
    'This item was made before retry could capture what you asked for. Run it again from the composer.',
  not_variable:
    'Variations only apply to generated images. Re-run this edit from the canvas instead.',
  reference_unavailable: 'The reference image this used is no longer available.',
  family_disabled: 'That model is temporarily unavailable.',
  catalog_changed:
    'This model has changed since that run. Start a new one to see the current price.',
  plan_required: 'Your plan no longer includes this model.',
};

/** Everything the decision needs, as data. The route does the I/O. */
export interface RetryContext {
  snapshot: GenerationRequestSnapshotV1 | null;
  /** Upload paths that still exist and belong to this user. */
  liveUploadPaths: Set<string>;
  /** `models.enabled` for the snapshot's family. */
  familyEnabled: boolean;
  /** The account's plan still covers this family. */
  entitled: boolean;
  /**
   * The snapshot's settings still validate against today's catalog.
   *
   * A price move alone is NOT a refusal — the retry is re-quoted and the
   * customer is charged today's price. This is for requests that can no longer
   * be expressed at all: a family that was removed, or an option the catalog
   * has withdrawn (FLUX's 4MP tier at 16:9, say).
   */
  expressible: boolean;
}

/** The body to POST back through the normal submission path. */
export interface RetryBody {
  op: string;
  familyId: string;
  prompt: string;
  batch: 1;
  settings: Record<string, unknown>;
  parentId?: string;
  style?: string;
  personaId?: string;
  trendId?: string;
  referenceUploadId?: string;
  referencePaths?: string[];
  maskUploadId?: string;
}

export type RetryDecision =
  | { ok: true; body: RetryBody }
  | { ok: false; refusal: RetryRefusal };

/** Shared gates. Order matters: the most specific reason wins. */
function precheck(ctx: RetryContext): RetryRefusal | null {
  if (!ctx.snapshot) return 'not_retryable';
  const rehydrated = rehydrate(ctx.snapshot);
  if (!rehydrated.ok) return 'not_retryable';
  if (!ctx.expressible) return 'catalog_changed';
  if (!ctx.familyEnabled) return 'family_disabled';
  if (!ctx.entitled) return 'plan_required';

  // Every input the request named must still be there. Finding out at the
  // provider costs the customer a failed job and a refund round trip.
  const needed = [...ctx.snapshot.referenceUploadIds];
  if (ctx.snapshot.maskUploadId) needed.push(ctx.snapshot.maskUploadId);
  const missing = needed.some((path) => !ctx.liveUploadPaths.has(path));
  if (missing) return 'reference_unavailable';
  return null;
}

/** Ordered video references, or the single image reference. */
function applyReferences(body: RetryBody, snapshot: GenerationRequestSnapshotV1): void {
  if (snapshot.mode) {
    // Order is meaning for keyframes: swapping these runs the video backwards.
    body.referencePaths = [...snapshot.referenceUploadIds];
    return;
  }
  const first = snapshot.referenceUploadIds[0];
  if (first) body.referenceUploadId = first;
}

function bodyOf(snapshot: GenerationRequestSnapshotV1): RetryBody {
  const settings: Record<string, unknown> = { ...snapshot.settings };
  if (snapshot.mode) settings.mode = snapshot.mode;
  const body: RetryBody = {
    op: snapshot.op,
    // The real model family, never the pseudo-family 'persona' the row is
    // displayed under.
    familyId: snapshot.familyId,
    prompt: snapshot.prompt,
    batch: 1,
    settings,
  };
  if (snapshot.parentId) body.parentId = snapshot.parentId;
  if (snapshot.styleId) body.style = snapshot.styleId;
  if (snapshot.personaId) body.personaId = snapshot.personaId;
  if (snapshot.trendId) body.trendId = snapshot.trendId;
  if (snapshot.maskUploadId) body.maskUploadId = snapshot.maskUploadId;
  applyReferences(body, snapshot);
  return body;
}

/**
 * Re-run exactly what was asked for.
 *
 * The price is NOT carried over: the body goes back through the normal
 * submission path, which quotes from today's catalog. A retry is a new
 * submission with its own idempotency key, not a replay of the old one.
 */
export function planRetry(ctx: RetryContext): RetryDecision {
  const refusal = precheck(ctx);
  if (refusal) return { ok: false, refusal };
  return { ok: true, body: bodyOf(ctx.snapshot!) };
}

/**
 * Another take on the same prompt, hung off the original as its parent.
 *
 * "Variation" only means something for a generated image. An edit is a change
 * to a specific picture, an upscale has one correct answer, a persona run is
 * pinned to a likeness, and a video's reference frames fix what it can be — so
 * those refuse rather than quietly producing something else.
 */
export function planVariation(ctx: RetryContext, parentId: string): RetryDecision {
  if (!ctx.snapshot) return { ok: false, refusal: 'not_retryable' };
  if (ctx.snapshot.op !== 'generate') return { ok: false, refusal: 'not_variable' };
  if (ctx.snapshot.personaId) return { ok: false, refusal: 'not_variable' };
  if (ctx.snapshot.mode) return { ok: false, refusal: 'not_variable' };

  const refusal = precheck(ctx);
  if (refusal) return { ok: false, refusal };

  const body = bodyOf(ctx.snapshot);
  // Without a parent the version chain breaks and the variation looks like an
  // unrelated generation in the library.
  body.parentId = parentId;
  return { ok: true, body };
}
