// Google Gemini image adapter — Nano Banana Fast/Standard/Pro. generateContent
// returns image bytes inline, so submit answers synchronously and check() is a
// defensive no-op for inline refs.
import { encodeBase64 } from 'jsr:@std/encoding/base64';
import { CheckResult, ProviderAdapter, SubmitCtx } from './types.ts';
import { GOOGLE_API_BASE, googleHeaders } from './google-common.ts';
import { ProviderError } from './provider-errors.ts';

/** One image as an inline part, or null when there is no URL or it cannot be read. */
async function referenceInline(url?: string): Promise<Record<string, unknown> | null> {
  if (!url) return null;
  const res = await fetch(url);
  if (!res.ok) return null;
  const contentType = res.headers.get('content-type') ?? 'image/png';
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { inline_data: { mime_type: contentType, data: encodeBase64(bytes) } };
}

export const googleAdapter: ProviderAdapter = {
  provider: 'google',

  async submit(ctx: SubmitCtx) {
    // Nano Banana was already correct; moving it onto the same seam as the
    // other adapters means a future catalog change cannot break it silently.
    const n = ctx.normalized;
    if (!n) throw new Error('google: normalized request is required');
    const model = n.providerModel;
    // Each persona photo is labelled with what it is, then the prompt comes
    // last so it follows the images it refers to, as Google's docs place it.
    // A persona photo that cannot be read fails the run: rendering four of
    // five angles would be a different likeness than the one paid for. It is
    // terminal because nothing reached Google, so dispatch refunds it at once
    // instead of holding the charge for reconciliation.
    const parts: unknown[] = [];
    for (const [i, photo] of (ctx.personaPhotos ?? []).entries()) {
      const inline = await referenceInline(photo.url);
      if (!inline) {
        throw new ProviderError(`google: persona photo ${photo.slot} unavailable`, 'terminal');
      }
      parts.push({ text: `Image ${i + 1}: ${photo.slot.replaceAll('_', ' ')}` });
      parts.push(inline);
    }
    const ref = await referenceInline(ctx.referenceUrl);
    if (ref) parts.push(ref);
    parts.push({ text: ctx.prompt });

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
    // Token usage per run, so the persona price can be checked against what
    // Google actually billed (thinking and five input photos vary).
    console.log(JSON.stringify({
      event: 'google_usage', model, imageSize: n.providerSettings.image_size ?? null,
      usage: data.usageMetadata ?? null,
    }));
    const inlinePart = data.candidates?.[0]?.content?.parts?.find(
      (p: Record<string, unknown>) => (p as { inline_data?: unknown; inlineData?: unknown }).inline_data ?? (p as { inlineData?: unknown }).inlineData,
    );
    const inline = inlinePart?.inline_data ?? inlinePart?.inlineData;
    // Google answered and nothing is in flight: there is nothing to reconcile,
    // so a retryable class would hold the charge forever. Terminal refunds once.
    if (!inline?.data) {
      const reason = data.candidates?.[0]?.finishReason ?? data.promptFeedback?.blockReason ??
        'unknown';
      throw new ProviderError(`google: no image in response (${reason})`, 'terminal');
    }
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
