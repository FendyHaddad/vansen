export type ModelKind = 'image' | 'video';

export interface CatalogModel {
  id: string;
  provider: string;
  name: string;
  kind: ModelKind;
  unit: string;
  usdCost: number;
}

/** Markup applied to provider cost under the pay-as-you-go model. */
export const PAYG_MARGIN = 0.33;

/** User-facing PAYG price: provider cost / (1 − margin). */
export function paygPriceUsd(model: CatalogModel): number {
  return model.usdCost / (1 - PAYG_MARGIN);
}

/** @deprecated superseded by core/catalog/model-families — kept for admin pages */
export const MODEL_CATALOG: CatalogModel[] = [
  { id: 'nano-banana', provider: 'Google', name: 'Nano Banana (Gemini 2.5 Flash Image)', kind: 'image', unit: 'per image', usdCost: 0.039 },
  { id: 'nano-banana-2-1k', provider: 'Google', name: 'Nano Banana 2 (Gemini 3.1 Flash Image, 1K)', kind: 'image', unit: 'per 1K image', usdCost: 0.067 },
  { id: 'nano-banana-2-2k', provider: 'Google', name: 'Nano Banana 2 (Gemini 3.1 Flash Image, 2K)', kind: 'image', unit: 'per 2K image', usdCost: 0.101 },
  { id: 'nano-banana-2-4k', provider: 'Google', name: 'Nano Banana 2 (Gemini 3.1 Flash Image, 4K)', kind: 'image', unit: 'per 4K image', usdCost: 0.151 },
  { id: 'flash-lite-image', provider: 'Google', name: 'Gemini 3.1 Flash Lite Image', kind: 'image', unit: 'per 1K image', usdCost: 0.0336 },
  { id: 'nano-banana-pro-1k', provider: 'Google', name: 'Nano Banana Pro (Gemini 3 Pro Image, 1K/2K)', kind: 'image', unit: 'per 1K/2K image', usdCost: 0.134 },
  { id: 'nano-banana-pro-4k', provider: 'Google', name: 'Nano Banana Pro (Gemini 3 Pro Image, 4K)', kind: 'image', unit: 'per 4K image', usdCost: 0.24 },
  { id: 'gpt-image-2-low', provider: 'OpenAI', name: 'GPT Image 2 (low)', kind: 'image', unit: 'per 1024px image', usdCost: 0.006 },
  { id: 'gpt-image-2-med', provider: 'OpenAI', name: 'GPT Image 2 (medium)', kind: 'image', unit: 'per 1024px image', usdCost: 0.053 },
  { id: 'gpt-image-2-high', provider: 'OpenAI', name: 'GPT Image 2 (high)', kind: 'image', unit: 'per 1024px image', usdCost: 0.211 },
  { id: 'gpt-image-15-med', provider: 'OpenAI', name: 'GPT Image 1.5 (medium)', kind: 'image', unit: 'per 1024px image', usdCost: 0.034 },
  { id: 'gpt-image-15-high', provider: 'OpenAI', name: 'GPT Image 1.5 (high)', kind: 'image', unit: 'per 1024px image', usdCost: 0.133 },
  { id: 'gpt-image-1-mini', provider: 'OpenAI', name: 'GPT Image 1 Mini (medium)', kind: 'image', unit: 'per 1024px image', usdCost: 0.011 },
  { id: 'seedream-4', provider: 'ByteDance', name: 'Seedream 4.0', kind: 'image', unit: 'per image (fal)', usdCost: 0.03 },
  { id: 'flux-2-pro', provider: 'Black Forest Labs', name: 'FLUX.2 [pro]', kind: 'image', unit: 'per megapixel (fal)', usdCost: 0.03 },
  { id: 'ideogram-v3-turbo', provider: 'Ideogram', name: 'Ideogram V3 (turbo)', kind: 'image', unit: 'per image (fal)', usdCost: 0.03 },
  { id: 'ideogram-v3-balanced', provider: 'Ideogram', name: 'Ideogram V3 (balanced)', kind: 'image', unit: 'per image (fal)', usdCost: 0.06 },
  { id: 'ideogram-v3-quality', provider: 'Ideogram', name: 'Ideogram V3 (quality)', kind: 'image', unit: 'per image (fal)', usdCost: 0.09 },
  { id: 'recraft-v3', provider: 'Recraft', name: 'Recraft V3', kind: 'image', unit: 'per image (fal)', usdCost: 0.04 },
  { id: 'veo-31', provider: 'Google', name: 'Veo 3.1 (720p/1080p, audio)', kind: 'video', unit: 'per 5s clip', usdCost: 2.0 },
  { id: 'veo-31-4k', provider: 'Google', name: 'Veo 3.1 (4K, audio)', kind: 'video', unit: 'per 5s clip', usdCost: 3.0 },
  { id: 'veo-31-fast', provider: 'Google', name: 'Veo 3.1 Fast (720p)', kind: 'video', unit: 'per 5s clip', usdCost: 0.5 },
  { id: 'veo-31-lite', provider: 'Google', name: 'Veo 3.1 Lite (720p)', kind: 'video', unit: 'per 5s clip', usdCost: 0.25 },
  { id: 'omni-flash', provider: 'Google', name: 'Gemini Omni Flash Preview (720p)', kind: 'video', unit: 'per 5s clip', usdCost: 0.5 },
  { id: 'sora-2', provider: 'OpenAI', name: 'Sora 2 (720p)', kind: 'video', unit: 'per 5s clip', usdCost: 0.5 },
  { id: 'sora-2-pro', provider: 'OpenAI', name: 'Sora 2 Pro (720p)', kind: 'video', unit: 'per 5s clip', usdCost: 1.5 },
  { id: 'sora-2-pro-1080', provider: 'OpenAI', name: 'Sora 2 Pro (1080p)', kind: 'video', unit: 'per 5s clip', usdCost: 3.5 },
  { id: 'seedance-1-pro', provider: 'ByteDance', name: 'Seedance 1.0 Pro (1080p)', kind: 'video', unit: 'per 5s clip (fal)', usdCost: 0.62 },
  { id: 'seedance-2', provider: 'ByteDance', name: 'Seedance 2 (720p, via Runway)', kind: 'video', unit: 'per 5s clip', usdCost: 1.8 },
  { id: 'kling-25-turbo', provider: 'Kuaishou', name: 'Kling 2.5 Turbo Pro', kind: 'video', unit: 'per 5s clip (fal)', usdCost: 0.35 },
  { id: 'hailuo-23', provider: 'MiniMax', name: 'Hailuo 2.3 Standard (768p)', kind: 'video', unit: 'per 6s clip (fal)', usdCost: 0.28 },
  { id: 'gen45', provider: 'Runway', name: 'Gen-4.5', kind: 'video', unit: 'per 5s clip', usdCost: 0.6 },
  { id: 'gen4-turbo', provider: 'Runway', name: 'Gen-4 Turbo', kind: 'video', unit: 'per 5s clip', usdCost: 0.25 },
];
