// OpenAI GPT Image adapter — generate + edits (mask). Responds inline with a
// base64 image, so submit answers synchronously.
//
// The model id and the `size` string come from the normalized request, never
// from a table in this file: the quote is computed from the same object, so a
// price the customer paid cannot describe a request we did not send.
import { CheckResult, ProviderAdapter, SubmitCtx } from './types.ts';

function key(): string {
  const k = Deno.env.get('OPENAI_API_KEY');
  if (!k) throw new Error('OPENAI_API_KEY missing');
  return k;
}

function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function urlToBlob(url: string): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`reference fetch ${res.status}`);
  return await res.blob();
}

async function submitReference(ctx: SubmitCtx, model: string, size: string, quality: string) {
  const form = new FormData();
  form.append('model', model);
  form.append('prompt', ctx.prompt);
  form.append('size', size);
  form.append('quality', quality);
  form.append('user', ctx.safetyId);
  form.append('image', await urlToBlob(ctx.referenceUrl!), 'source.png');
  if (ctx.maskPngBase64) {
    const maskBytes = base64ToBytes(ctx.maskPngBase64.replace(/^data:image\/\w+;base64,/, ''));
    form.append('mask', new Blob([maskBytes as BlobPart], { type: 'image/png' }), 'mask.png');
  }
  const res = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key()}` },
    body: form,
  });
  if (!res.ok) throw new Error(`openai edit ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const bytes = base64ToBytes(data.data[0].b64_json);
  return {
    providerRef: 'inline',
    inline: { state: 'done' as const, bytes, contentType: 'image/png' },
  };
}

export const openaiAdapter: ProviderAdapter = {
  provider: 'openai',

  async submit(ctx: SubmitCtx) {
    const n = ctx.normalized;
    if (!n) throw new Error('openai: normalized request is required');
    const model = n.providerModel;
    const size = String(n.providerSettings.size);
    const quality = String(n.providerSettings.quality);

    // Any reference means the edits endpoint. Gating this on op === 'edit'
    // made an uploaded reference on a plain generate vanish between the
    // gateway and OpenAI, after the customer had already been charged.
    if (ctx.referenceUrl) return await submitReference(ctx, model, size, quality);

    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: ctx.prompt, size, quality, user: ctx.safetyId, n: 1 }),
    });
    if (!res.ok) throw new Error(`openai generate ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const bytes = base64ToBytes(data.data[0].b64_json);
    return { providerRef: 'inline', inline: { state: 'done' as const, bytes, contentType: 'image/png' } };
  },

  async check(_ref: string): Promise<CheckResult> {
    return { state: 'running' };
  },
};
