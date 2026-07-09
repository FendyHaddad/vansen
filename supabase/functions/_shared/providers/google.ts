// Google Gemini image adapter — Nano Banana Fast/Standard/Pro. generateContent
// returns image bytes inline, so submit answers synchronously and check() is a
// defensive no-op for inline refs.
import { CheckResult, ProviderAdapter, SubmitCtx } from './types.ts';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

function key(): string {
  const k = Deno.env.get('GOOGLE_AI_API_KEY');
  if (!k) throw new Error('GOOGLE_AI_API_KEY missing');
  return k;
}

/** Nano Banana version → Gemini image model id. */
function modelFor(ctx: SubmitCtx): string {
  const version = String(ctx.settings.version ?? 'standard');
  if (version === 'fast') return 'gemini-2.5-flash-image';
  if (version === 'pro') return 'gemini-3-pro-image';
  return 'gemini-3.1-flash-image';
}

async function referenceInline(referenceUrl?: string): Promise<Record<string, unknown> | null> {
  if (!referenceUrl) return null;
  const res = await fetch(referenceUrl);
  if (!res.ok) return null;
  const contentType = res.headers.get('content-type') ?? 'image/png';
  const bytes = new Uint8Array(await res.arrayBuffer());
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return { inline_data: { mime_type: contentType, data: btoa(binary) } };
}

export const googleAdapter: ProviderAdapter = {
  provider: 'google',

  async submit(ctx: SubmitCtx) {
    const model = modelFor(ctx);
    const parts: unknown[] = [{ text: ctx.prompt }];
    const ref = await referenceInline(ctx.referenceUrl);
    if (ref) parts.push(ref);

    const responseFormat: Record<string, unknown> = {};
    if (ctx.settings.resolution) responseFormat.image_size = String(ctx.settings.resolution);
    if (ctx.settings.aspectRatio) responseFormat.aspect_ratio = String(ctx.settings.aspectRatio);

    const res = await fetch(`${API_BASE}/${model}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': key(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: {
          responseModalities: ['IMAGE'],
          ...(Object.keys(responseFormat).length ? { imageConfig: responseFormat } : {}),
        },
        safetySettings: [],
      }),
    });
    if (!res.ok) throw new Error(`google submit ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const inlinePart = data.candidates?.[0]?.content?.parts?.find(
      (p: Record<string, unknown>) => (p as { inline_data?: unknown; inlineData?: unknown }).inline_data ?? (p as { inlineData?: unknown }).inlineData,
    );
    const inline = inlinePart?.inline_data ?? inlinePart?.inlineData;
    if (!inline?.data) throw new Error('google: no image in response');
    const bytes = Uint8Array.from(atob(inline.data), (ch) => ch.charCodeAt(0));
    const contentType = inline.mime_type ?? inline.mimeType ?? 'image/png';
    return {
      providerRef: 'inline',
      inline: { state: 'done', bytes, contentType },
    };
  },

  async check(_ref: string): Promise<CheckResult> {
    // Google resolves inline at submit; nothing to poll.
    return { state: 'running' };
  },
};
