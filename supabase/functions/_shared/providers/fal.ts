// fal.ai adapter — FLUX, Seedream, and the clarity upscaler. Queue API:
// submit returns a request_id; check polls status then pulls the result.
import { CheckResult, ProviderAdapter, SubmitCtx, fetchBytes } from './types.ts';

const FAL_BASE = 'https://queue.fal.run';

function key(): string {
  const k = Deno.env.get('FAL_API_KEY');
  if (!k) throw new Error('FAL_API_KEY missing');
  return k;
}

/** familyId (+ op/reference) → fal model slug. */
function slugFor(ctx: SubmitCtx): string {
  if (ctx.familyId === 'upscaler' || ctx.op === 'upscale') return 'fal-ai/clarity-upscaler';
  if (ctx.familyId === 'flux') return 'fal-ai/flux-pro/v1.1';
  if (ctx.familyId === 'seedream') {
    return ctx.referenceUrl
      ? 'fal-ai/bytedance/seedream/v4/edit'
      : 'fal-ai/bytedance/seedream/v4/text-to-image';
  }
  throw new Error(`fal: no slug for ${ctx.familyId}`);
}

function payloadFor(ctx: SubmitCtx): Record<string, unknown> {
  const aspect = String(ctx.settings.aspectRatio ?? '1:1');
  if (ctx.familyId === 'upscaler' || ctx.op === 'upscale') {
    return { image_url: ctx.referenceUrl };
  }
  const body: Record<string, unknown> = { prompt: ctx.prompt, aspect_ratio: aspect };
  if (ctx.referenceUrl) {
    // Seedream's edit endpoint takes a list of reference images; others take one.
    if (ctx.familyId === 'seedream') body.image_urls = [ctx.referenceUrl];
    else body.image_url = ctx.referenceUrl;
  }
  return body;
}

async function auth(): Promise<Record<string, string>> {
  return { Authorization: `Key ${key()}`, 'Content-Type': 'application/json' };
}

export const falAdapter: ProviderAdapter = {
  provider: 'fal',

  async submit(ctx: SubmitCtx) {
    const slug = slugFor(ctx);
    const res = await fetch(`${FAL_BASE}/${slug}`, {
      method: 'POST',
      headers: await auth(),
      body: JSON.stringify(payloadFor(ctx)),
    });
    if (!res.ok) throw new Error(`fal submit ${res.status}: ${await res.text()}`);
    const data = await res.json();
    // Store the queue's canonical URLs — they live under the app alias root
    // (e.g. fal-ai/bytedance/requests/{id}), not under the full model path.
    return {
      providerRef: JSON.stringify({ statusUrl: data.status_url, responseUrl: data.response_url }),
    };
  },

  async check(providerRef: string): Promise<CheckResult> {
    const ref = JSON.parse(providerRef) as { statusUrl?: string; responseUrl?: string };
    if (!ref.statusUrl?.startsWith(FAL_BASE) || !ref.responseUrl?.startsWith(FAL_BASE)) {
      return { state: 'failed', error: 'fal ref missing queue urls' };
    }
    const statusRes = await fetch(ref.statusUrl, {
      headers: { Authorization: `Key ${key()}` },
    });
    if (!statusRes.ok) return { state: 'failed', error: `fal status ${statusRes.status}` };
    const status = await statusRes.json();
    if (status.status !== 'COMPLETED') {
      if (status.status === 'IN_QUEUE' || status.status === 'IN_PROGRESS') return { state: 'running' };
      return { state: 'failed', error: `fal status ${status.status}` };
    }
    const resultRes = await fetch(ref.responseUrl, {
      headers: { Authorization: `Key ${key()}` },
    });
    if (!resultRes.ok) {
      const detail = (await resultRes.text()).slice(0, 300);
      return { state: 'failed', error: `fal result ${resultRes.status}: ${detail}` };
    }
    const result = await resultRes.json();
    const imageUrl = result.images?.[0]?.url ?? result.image?.url;
    if (!imageUrl) return { state: 'failed', error: 'fal result had no image' };
    const { bytes, contentType } = await fetchBytes(imageUrl);
    return { state: 'done', bytes, contentType };
  },
};
