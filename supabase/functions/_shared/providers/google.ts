// Google Gemini image adapter — Nano Banana Fast/Standard/Pro. generateContent
// returns image bytes inline, so submit answers synchronously and check() is a
// defensive no-op for inline refs.
import { CheckResult, ProviderAdapter, SubmitCtx } from './types.ts';
import { GOOGLE_API_BASE, googleHeaders } from './google-common.ts';

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
    // Nano Banana was already correct; moving it onto the same seam as the
    // other adapters means a future catalog change cannot break it silently.
    const n = ctx.normalized;
    if (!n) throw new Error('google: normalized request is required');
    const model = n.providerModel;
    const parts: unknown[] = [{ text: ctx.prompt }];
    const ref = await referenceInline(ctx.referenceUrl);
    if (ref) parts.push(ref);

    // Exactly the axes the quote was computed from — no re-derivation here.
    const responseFormat: Record<string, unknown> = n.providerSettings;

    const res = await fetch(`${GOOGLE_API_BASE}/models/${model}:generateContent`, {
      method: 'POST',
      headers: googleHeaders(),
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
