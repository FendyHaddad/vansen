// OpenAI GPT Image adapter — generate + edits (mask). Responds inline with
// base64 image, so submit answers synchronously.
import { CheckResult, ProviderAdapter, SubmitCtx } from './types.ts';

function key(): string {
  const k = Deno.env.get('OPENAI_API_KEY');
  if (!k) throw new Error('OPENAI_API_KEY missing');
  return k;
}

const MODEL = 'gpt-image-1';

/** aspect ratio + resolution → nearest supported gpt-image size. */
function sizeFor(ctx: SubmitCtx): string {
  const ar = String(ctx.settings.aspectRatio ?? '1:1');
  if (ar === '16:9' || ar === '4:3') return '1536x1024';
  if (ar === '9:16' || ar === '3:4') return '1024x1536';
  return '1024x1024';
}

function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function urlToBlob(url: string): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`reference fetch ${res.status}`);
  return await res.blob();
}

export const openaiAdapter: ProviderAdapter = {
  provider: 'openai',

  async submit(ctx: SubmitCtx) {
    const quality = String(ctx.settings.quality ?? 'medium');
    const size = sizeFor(ctx);
    let bytes: Uint8Array;
    let contentType = 'image/png';

    if (ctx.referenceUrl && (ctx.op === 'edit' || ctx.op === 'upscale')) {
      // Edits endpoint: multipart with the source image (+ optional mask).
      const form = new FormData();
      form.append('model', MODEL);
      form.append('prompt', ctx.prompt);
      form.append('size', size);
      form.append('quality', quality);
      form.append('user', ctx.safetyId);
      form.append('image', await urlToBlob(ctx.referenceUrl), 'source.png');
      if (ctx.maskPngBase64) {
        const maskBytes = base64ToBytes(ctx.maskPngBase64.replace(/^data:image\/\w+;base64,/, ''));
        form.append('mask', new Blob([maskBytes], { type: 'image/png' }), 'mask.png');
      }
      const res = await fetch('https://api.openai.com/v1/images/edits', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key()}` },
        body: form,
      });
      if (!res.ok) throw new Error(`openai edit ${res.status}: ${await res.text()}`);
      const data = await res.json();
      bytes = base64ToBytes(data.data[0].b64_json);
    } else {
      const res = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          prompt: ctx.prompt,
          size,
          quality,
          user: ctx.safetyId,
          n: 1,
        }),
      });
      if (!res.ok) throw new Error(`openai generate ${res.status}: ${await res.text()}`);
      const data = await res.json();
      bytes = base64ToBytes(data.data[0].b64_json);
    }

    return { providerRef: 'inline', inline: { state: 'done', bytes, contentType } };
  },

  async check(_ref: string): Promise<CheckResult> {
    return { state: 'running' };
  },
};
