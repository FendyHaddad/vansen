// Provider adapter contract. Server-only (not synced from Angular).
import type { VideoMode } from '../model-families.ts';

export type ProviderName = 'google' | 'openai' | 'fal' | 'runway';
export type JobPhase = 'queued' | 'rendering';

export interface SubmitCtx {
  familyId: string;
  op: string;
  prompt: string;
  settings: Record<string, unknown>;
  /** Signed URL of a stored upload or parent generation, for image-to-image / edits. */
  referenceUrl?: string;
  /** Base64 PNG mask for GPT edits. */
  maskPngBase64?: string;
  /** fal-hosted LoRA weights URL for persona generations (familyId 'persona'). */
  loraUrl?: string;
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
  | { state: 'failed'; error: string };

export interface SubmitResult {
  providerRef: string;
  inline?: CheckResult;
  /** Omni only: conversation id persisted into generation settings. */
  interactionId?: string;
}

export interface ProviderAdapter {
  readonly provider: ProviderName;
  /** Start async work. May return an inline result when the provider answers synchronously. */
  submit(ctx: SubmitCtx): Promise<SubmitResult>;
  check(providerRef: string): Promise<CheckResult>;
  /** Optional. Providers that cannot cancel omit it (Veo, Omni). */
  cancel?(providerRef: string): Promise<void>;
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
