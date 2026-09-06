// fal.ai adapter — FLUX, Seedream, and the clarity upscaler. Queue API:
// submit returns a request_id; check polls status then pulls the result.
import { CheckResult, ProviderAdapter, SubmitCtx, fetchBytes } from './types.ts';

const FAL_BASE = 'https://queue.fal.run';

function key(): string {
  const k = Deno.env.get('FAL_API_KEY');
  if (!k) throw new Error('FAL_API_KEY missing');
  return k;
}

const FILL_TOOLS = ['edit-remove', 'edit-fill', 'edit-expand'];

const VIDEO_FAMILIES = new Set(['kling', 'seedance']);

const KLING_SLUGS: Partial<Record<string, string>> = {
  t2v: 'fal-ai/kling-video/v3/pro/text-to-video',
  i2v: 'fal-ai/kling-video/v3/pro/image-to-video',
  keyframes: 'fal-ai/kling-video/v3/pro/image-to-video',
};

const SEEDANCE_SLUGS: Partial<Record<string, string>> = {
  t2v: 'bytedance/seedance-2.5/text-to-video',
  i2v: 'bytedance/seedance-2.5/image-to-video',
  ref2v: 'bytedance/seedance-2.5/reference-to-video',
};

/** Video familyId (+ mode) → fal model slug. */
export function videoSlugFor(ctx: SubmitCtx): string {
  const mode = ctx.mode ?? 't2v';
  const table = ctx.familyId === 'kling' ? KLING_SLUGS : SEEDANCE_SLUGS;
  const slug = table[mode];
  if (!slug) throw new Error('unsupported_mode');
  return slug;
}

/** Video familyId (+ mode/settings/referenceUrls) → fal request body. */
export function videoPayloadFor(ctx: SubmitCtx): Record<string, unknown> {
  const s = ctx.settings;
  const mode = ctx.mode ?? 't2v';
  const refs = ctx.referenceUrls ?? [];
  const payload: Record<string, unknown> = {
    prompt: ctx.prompt,
    duration: String(typeof s.durationS === 'number' ? s.durationS : 5),
  };
  if (mode === 't2v') payload.aspect_ratio = s.aspectRatio ?? '16:9';
  if (mode === 'i2v' || mode === 'keyframes') payload.image_url = refs[0];
  if (mode === 'keyframes' && refs[1]) payload.tail_image_url = refs[1];
  if (mode === 'ref2v') payload.reference_image_urls = refs.slice(0, 3);
  if (ctx.familyId === 'kling') {
    payload.generate_audio = s.audio === 'on' || s.audio === 'voice';
    payload.voice = s.audio === 'voice';
  }
  if (ctx.familyId === 'seedance') payload.resolution = s.resolution ?? '720p';
  return payload;
}

/** familyId (+ op/reference) → fal model slug. */
function slugFor(ctx: SubmitCtx): string {
  if (VIDEO_FAMILIES.has(ctx.familyId)) return videoSlugFor(ctx);
  if (ctx.familyId === 'upscaler' || ctx.op === 'upscale') return 'fal-ai/clarity-upscaler';
  if (ctx.familyId === 'edit-bg') return 'fal-ai/birefnet/v2';
  if (FILL_TOOLS.includes(ctx.familyId)) return 'fal-ai/flux-pro/v1/fill';
  if (ctx.familyId === 'persona') return 'fal-ai/flux-lora';
  if (ctx.familyId === 'flux') return 'fal-ai/flux-pro/v1.1';
  if (ctx.familyId === 'seedream') {
    return ctx.referenceUrl
      ? 'fal-ai/bytedance/seedream/v4/edit'
      : 'fal-ai/bytedance/seedream/v4/text-to-image';
  }
  throw new Error(`fal: no slug for ${ctx.familyId}`);
}

/** Our aspect ratios → fal image_size presets (~1MP each). */
const PERSONA_SIZES: Record<string, string> = {
  '1:1': 'square_hd',
  '3:4': 'portrait_4_3',
  '9:16': 'portrait_16_9',
  '4:3': 'landscape_4_3',
  '16:9': 'landscape_16_9',
};

function payloadFor(ctx: SubmitCtx): Record<string, unknown> {
  if (VIDEO_FAMILIES.has(ctx.familyId)) return videoPayloadFor(ctx);
  const aspect = String(ctx.settings.aspectRatio ?? '1:1');
  if (ctx.familyId === 'persona') {
    return {
      prompt: ctx.prompt,
      image_size: PERSONA_SIZES[aspect] ?? 'square_hd',
      loras: [{ path: ctx.loraUrl, scale: 1 }],
      num_images: 1,
      output_format: 'png',
    };
  }
  if (ctx.familyId === 'upscaler' || ctx.op === 'upscale') {
    return { image_url: ctx.referenceUrl };
  }
  if (ctx.familyId === 'edit-bg') {
    return { image_url: ctx.referenceUrl };
  }
  if (FILL_TOOLS.includes(ctx.familyId)) {
    // FLUX fill repaints where the mask is white. The mask arrives as a data
    // URI (fal accepts data: URLs). Expand sends a pre-padded image + border
    // mask the client built; remove/expand use fixed client-side prompts.
    return {
      image_url: ctx.referenceUrl,
      mask_url: ctx.maskPngBase64,
      prompt: ctx.prompt,
    };
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
    if (status.status === 'IN_QUEUE' && typeof status.queue_position === 'number') {
      return { state: 'running', phase: 'queued', queuePosition: status.queue_position };
    }
    if (status.status === 'IN_QUEUE') return { state: 'running', phase: 'queued' };
    if (status.status === 'IN_PROGRESS') return { state: 'running', phase: 'rendering' };
    if (status.status !== 'COMPLETED') {
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
    if (result.video?.url) return { state: 'done', url: result.video.url, contentType: 'video/mp4' };
    const imageUrl = result.images?.[0]?.url ?? result.image?.url;
    if (!imageUrl) return { state: 'failed', error: 'fal result had no image' };
    const { bytes, contentType } = await fetchBytes(imageUrl);
    return { state: 'done', bytes, contentType };
  },

  async cancel(providerRef: string): Promise<void> {
    const ref = JSON.parse(providerRef) as { statusUrl?: string; responseUrl?: string };
    if (!ref.statusUrl?.startsWith(FAL_BASE) || !ref.responseUrl?.startsWith(FAL_BASE)) return;
    const statusRes = await fetch(ref.statusUrl, { headers: { Authorization: `Key ${key()}` } });
    if (!statusRes.ok) {
      throw new Error(`fal cancel status ${statusRes.status}: ${(await statusRes.text()).slice(0, 300)}`);
    }
    const status = (await statusRes.json()) as { status: string };
    if (status.status !== 'IN_QUEUE') return;
    const cancelRes = await fetch(`${ref.responseUrl}/cancel`, {
      method: 'PUT',
      headers: { Authorization: `Key ${key()}` },
    });
    if (!cancelRes.ok) {
      throw new Error(`fal cancel ${cancelRes.status}: ${(await cancelRes.text()).slice(0, 300)}`);
    }
  },
};

// --- Persona LoRA training (queue API, polled by GET /personas) -------------

const TRAINER_SLUG = 'fal-ai/flux-lora-portrait-trainer';

/** Fixed trigger phrase baked into every persona's captions; the api gateway
 * prepends it to persona prompts. Stored per-persona for forward-compat. */
export const PERSONA_TRIGGER = 'VNSNPRSN';

export async function submitPersonaTraining(zipUrl: string): Promise<string> {
  const res = await fetch(`${FAL_BASE}/${TRAINER_SLUG}`, {
    method: 'POST',
    headers: await auth(),
    body: JSON.stringify({
      images_data_url: zipUrl,
      trigger_phrase: PERSONA_TRIGGER,
      steps: 1000,
      subject_crop: true,
    }),
  });
  if (!res.ok) throw new Error(`fal training submit ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return JSON.stringify({ statusUrl: data.status_url, responseUrl: data.response_url });
}

export type TrainingCheck =
  | { state: 'running' }
  | { state: 'failed'; error: string }
  | { state: 'done'; loraUrl: string };

export async function checkPersonaTraining(providerRef: string): Promise<TrainingCheck> {
  const ref = JSON.parse(providerRef) as { statusUrl?: string; responseUrl?: string };
  if (!ref.statusUrl?.startsWith(FAL_BASE) || !ref.responseUrl?.startsWith(FAL_BASE)) {
    return { state: 'failed', error: 'fal ref missing queue urls' };
  }
  const statusRes = await fetch(ref.statusUrl, { headers: { Authorization: `Key ${key()}` } });
  if (!statusRes.ok) return { state: 'failed', error: `fal status ${statusRes.status}` };
  const status = await statusRes.json();
  if (status.status !== 'COMPLETED') {
    if (status.status === 'IN_QUEUE' || status.status === 'IN_PROGRESS') return { state: 'running' };
    return { state: 'failed', error: `fal status ${status.status}` };
  }
  const resultRes = await fetch(ref.responseUrl, { headers: { Authorization: `Key ${key()}` } });
  if (!resultRes.ok) {
    return { state: 'failed', error: `fal result ${resultRes.status}` };
  }
  const result = await resultRes.json();
  const loraUrl = result.diffusers_lora_file?.url;
  if (!loraUrl) return { state: 'failed', error: 'fal training result had no lora file' };
  return { state: 'done', loraUrl };
}
