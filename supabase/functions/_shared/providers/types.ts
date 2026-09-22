// Provider adapter contract. Server-only (not synced from Angular).
import type { VideoMode } from '../model-families.ts';

import type { NormalizedRequest } from '../generation-request.ts';

export type ProviderName = 'google' | 'openai' | 'fal' | 'runway';
export type JobPhase = 'queued' | 'rendering';

export interface SubmitCtx {
  familyId: string;
  op: string;
  prompt: string;
  settings: Record<string, unknown>;
  /**
   * The versioned request the quote was computed from. Image adapters REQUIRE
   * it: deriving the model or size from raw settings is what let a customer pay
   * for a 4K v2 render and receive a 1K v1 one. Optional only so the video
   * adapters, which are normalized in P5, keep compiling.
   */
  normalized?: NormalizedRequest;
  /** Signed URL of a stored upload or parent generation, for image-to-image / edits. */
  referenceUrl?: string;
  /** Base64 PNG mask for GPT edits. */
  maskPngBase64?: string;
  /** Persona generations: the five photos in slot order, each signed for this run. */
  personaPhotos?: { slot: string; url: string }[];
  /** sha256(user_id) — provider-side abuse attribution. */
  safetyId: string;
  /** Video only. */
  mode?: VideoMode;
  /** Signed URLs (1 h). ref2v: 1–3 refs; keyframes: [first, last]. */
  referenceUrls?: string[];
  /** Signed URL of the parent video for extend/edit. */
  parentVideoUrl?: string;
  /** Omni conversation id for extend/edit. */
  interactionId?: string;
}

export type CheckResult =
  | { state: 'running'; progress?: number; phase?: JobPhase; queuePosition?: number }
  | { state: 'done'; bytes: Uint8Array; contentType: string }
  | {
      state: 'done';
      url: string;
      headers?: Record<string, string>;
      contentType: string;
      durationS?: number;
      width?: number;
      height?: number;
    }
  | { state: 'failed'; error: string }
  /** The provider is briefly unavailable. Poll again; do NOT refund. */
  | { state: 'retryable_failure'; error: string; retryAfterSeconds?: number };

export interface SubmitResult {
  providerRef: string;
  inline?: CheckResult;
  /** Omni only: conversation id persisted into generation settings. */
  interactionId?: string;
}

/**
 * What actually happened when we asked the provider to stop.
 * `unreachable` is the important one: it must never produce a refund, because
 * the job is probably still running and will still bill us.
 */
export type CancelOutcome = 'cancelled' | 'too_late' | 'unsupported' | 'unreachable';

export interface ProviderAdapter {
  readonly provider: ProviderName;
  /** Start async work. May return an inline result when the provider answers synchronously. */
  submit(ctx: SubmitCtx): Promise<SubmitResult>;
  check(providerRef: string): Promise<CheckResult>;
  /** Optional. Providers that cannot cancel omit it (Veo, Omni). */
  cancel?(providerRef: string): Promise<CancelOutcome>;
}

export function isUrlResult(r: CheckResult): r is Extract<CheckResult, { url: string }> {
  return r.state === 'done' && 'url' in r;
}

export async function fetchBytes(url: string, init?: RequestInit): Promise<{ bytes: Uint8Array; contentType: string }> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  const contentType = res.headers.get('content-type') ?? 'image/png';
  return { bytes: new Uint8Array(await res.arrayBuffer()), contentType };
}
