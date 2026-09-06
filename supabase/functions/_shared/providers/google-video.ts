import { encodeBase64 } from 'jsr:@std/encoding/base64';
import type { CheckResult, ProviderAdapter, SubmitCtx, SubmitResult } from './types.ts';
import { GOOGLE_API_BASE, googleHeaders, googleKey } from './google-common.ts';

const SUPPORTED = new Set(['t2v', 'i2v', 'ref2v', 'keyframes', 'extend']);

export function veoModelFor(version: unknown): string {
  if (version === 'fast') return 'veo-3.1-fast-generate-preview';
  if (version === 'lite') return 'veo-3.1-lite-generate-preview';
  return 'veo-3.1-generate-preview';
}

interface InlineMedia {
  bytesBase64Encoded: string;
  mimeType: string;
}

async function inlineMedia(url: string, fallbackMime: string): Promise<InlineMedia> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`reference fetch ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return {
    bytesBase64Encoded: encodeBase64(bytes),
    mimeType: res.headers.get('content-type')?.split(';')[0] ?? fallbackMime,
  };
}

async function instanceFor(ctx: SubmitCtx): Promise<Record<string, unknown>> {
  const instance: Record<string, unknown> = { prompt: ctx.prompt };
  const refs = ctx.referenceUrls ?? [];
  const mode = ctx.mode ?? 't2v';
  if (mode === 'i2v' && refs[0]) instance.image = await inlineMedia(refs[0], 'image/png');
  if (mode === 'keyframes' && refs[0]) instance.image = await inlineMedia(refs[0], 'image/png');
  if (mode === 'keyframes' && refs[1]) instance.lastFrame = await inlineMedia(refs[1], 'image/png');
  if (mode === 'ref2v' && refs.length > 0) {
    instance.referenceImages = await Promise.all(
      refs.slice(0, 3).map(async (u) => ({ image: await inlineMedia(u, 'image/png'), referenceType: 'asset' })),
    );
  }
  if (mode === 'extend' && ctx.parentVideoUrl) instance.video = await inlineMedia(ctx.parentVideoUrl, 'video/mp4');
  return instance;
}

function parametersFor(ctx: SubmitCtx): Record<string, unknown> {
  const s = ctx.settings;
  return {
    aspectRatio: s.aspectRatio ?? '16:9',
    resolution: s.resolution ?? '1080p',
    durationSeconds: typeof s.durationS === 'number' ? s.durationS : 8,
    personGeneration: 'allow_adult',
  };
}

function isBlocked(op: Record<string, unknown>): boolean {
  const err = op.error as { message?: string } | undefined;
  if (err) return true;
  const resp = (op.response as { generateVideoResponse?: Record<string, unknown> } | undefined)?.generateVideoResponse;
  if (!resp) return true;
  const samples = (resp.generatedSamples as unknown[] | undefined) ?? [];
  return samples.length === 0;
}

export const googleVideoAdapter: ProviderAdapter = {
  provider: 'google',

  async submit(ctx: SubmitCtx): Promise<SubmitResult> {
    const mode = ctx.mode ?? 't2v';
    if (!SUPPORTED.has(mode)) throw new Error('unsupported_mode');
    const model = veoModelFor(ctx.settings.version);
    const body = { instances: [await instanceFor(ctx)], parameters: parametersFor(ctx) };
    const res = await fetch(`${GOOGLE_API_BASE}/models/${model}:predictLongRunning`, {
      method: 'POST',
      headers: googleHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`veo submit ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as { name?: string };
    if (!data.name) throw new Error('veo submit: missing operation name');
    return { providerRef: data.name };
  },

  async check(providerRef: string): Promise<CheckResult> {
    if (!/^models\/[\w.-]+\/operations\/[\w-]+$/.test(providerRef)) {
      return { state: 'failed', error: 'bad_provider_ref' };
    }
    const res = await fetch(`${GOOGLE_API_BASE}/${providerRef}`, { headers: googleHeaders() });
    if (!res.ok) throw new Error(`veo poll ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const op = (await res.json()) as Record<string, unknown>;
    if (!op.done) return { state: 'running', phase: 'rendering' };
    if (isBlocked(op)) return { state: 'failed', error: 'provider_blocked' };
    const resp = (op.response as { generateVideoResponse: { generatedSamples: { video: { uri: string } }[] } })
      .generateVideoResponse;
    return {
      state: 'done',
      url: resp.generatedSamples[0].video.uri,
      contentType: 'video/mp4',
      headers: { 'x-goog-api-key': googleKey() },
    };
  },
};
