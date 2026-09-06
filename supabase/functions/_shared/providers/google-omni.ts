import type { CheckResult, ProviderAdapter, SubmitCtx, SubmitResult } from './types.ts';
import { GOOGLE_API_BASE, googleHeaders, googleKey } from './google-common.ts';

const MODEL = 'gemini-omni-flash-1.1';

type InputPart = { type: 'text'; text: string } | { type: 'image' | 'video'; uri: string };

function inputFor(ctx: SubmitCtx): InputPart[] {
  const parts: InputPart[] = [{ type: 'text', text: ctx.prompt }];
  for (const u of ctx.referenceUrls ?? []) parts.push({ type: 'image', uri: u });
  const needsParent = (ctx.mode === 'extend' || ctx.mode === 'edit') && !ctx.interactionId;
  if (needsParent && ctx.parentVideoUrl) parts.push({ type: 'video', uri: ctx.parentVideoUrl });
  return parts;
}

function isSafetyFailure(err: { code?: string; message?: string } | undefined): boolean {
  if (!err) return false;
  const text = `${err.code ?? ''} ${err.message ?? ''}`.toLowerCase();
  return text.includes('safety') || text.includes('blocked') || text.includes('policy');
}

export const googleOmniAdapter: ProviderAdapter = {
  provider: 'google',

  async submit(ctx: SubmitCtx): Promise<SubmitResult> {
    const s = ctx.settings;
    const body: Record<string, unknown> = {
      model: MODEL,
      background: true,
      input: inputFor(ctx),
      generation_config: {
        video_config: {
          aspect_ratio: s.aspectRatio ?? '16:9',
          resolution: s.resolution ?? '720p',
          duration_seconds: typeof s.durationS === 'number' ? s.durationS : 8,
        },
      },
    };
    if (ctx.interactionId) body.previous_interaction_id = ctx.interactionId;
    const res = await fetch(`${GOOGLE_API_BASE}/interactions`, {
      method: 'POST',
      headers: googleHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`omni submit ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as { id?: string };
    if (!data.id) throw new Error('omni submit: missing interaction id');
    return { providerRef: data.id, interactionId: data.id };
  },

  async check(providerRef: string): Promise<CheckResult> {
    if (!/^[\w-]+$/.test(providerRef)) return { state: 'failed', error: 'bad_provider_ref' };
    const res = await fetch(`${GOOGLE_API_BASE}/interactions/${providerRef}`, { headers: googleHeaders() });
    if (!res.ok) throw new Error(`omni poll ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as {
      status: string;
      outputs?: { type: string; uri?: string; mime_type?: string }[];
      error?: { code?: string; message?: string };
    };
    if (data.status === 'in_progress' || data.status === 'queued') return { state: 'running', phase: 'rendering' };
    if (data.status !== 'completed') {
      return { state: 'failed', error: isSafetyFailure(data.error) ? 'provider_blocked' : 'provider_failed' };
    }
    const video = data.outputs?.find((o) => o.type === 'video' && o.uri);
    if (!video?.uri) return { state: 'failed', error: 'provider_blocked' };
    return {
      state: 'done',
      url: video.uri,
      contentType: video.mime_type ?? 'video/mp4',
      headers: { 'x-goog-api-key': googleKey() },
    };
  },
};
