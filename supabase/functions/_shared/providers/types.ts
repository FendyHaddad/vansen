// Provider adapter contract. Server-only (not synced from Angular).

export interface SubmitCtx {
  familyId: string;
  op: string;
  prompt: string;
  settings: Record<string, unknown>;
  /** Signed URL of a stored upload or parent generation, for image-to-image / edits. */
  referenceUrl?: string;
  /** Base64 PNG mask for GPT edits. */
  maskPngBase64?: string;
  /** sha256(user_id) — provider-side abuse attribution. */
  safetyId: string;
}

export type CheckResult =
  | { state: 'running' }
  | { state: 'done'; bytes: Uint8Array; contentType: string }
  | { state: 'failed'; error: string };

export interface ProviderAdapter {
  readonly provider: 'google' | 'openai' | 'fal';
  /** Start async work. May return an inline result when the provider answers synchronously. */
  submit(ctx: SubmitCtx): Promise<{ providerRef: string; inline?: CheckResult }>;
  check(providerRef: string): Promise<CheckResult>;
}

export async function fetchBytes(url: string, init?: RequestInit): Promise<{ bytes: Uint8Array; contentType: string }> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  const contentType = res.headers.get('content-type') ?? 'image/png';
  return { bytes: new Uint8Array(await res.arrayBuffer()), contentType };
}
