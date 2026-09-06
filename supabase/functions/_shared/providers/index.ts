import { ProviderAdapter } from './types.ts';
import { falAdapter } from './fal.ts';
import { googleAdapter } from './google.ts';
import { googleOmniAdapter } from './google-omni.ts';
import { googleVideoAdapter } from './google-video.ts';
import { openaiAdapter } from './openai.ts';
import { runwayAdapter } from './runway.ts';

const BY_FAMILY: Record<string, ProviderAdapter> = {
  'nano-banana': googleAdapter,
  'gpt-image': openaiAdapter,
  flux: falAdapter,
  seedream: falAdapter,
  upscaler: falAdapter,
  persona: falAdapter,
  // Studio panel AI edit tools — all fal (FLUX fill + BiRefNet)
  'edit-remove': falAdapter,
  'edit-fill': falAdapter,
  'edit-expand': falAdapter,
  'edit-bg': falAdapter,
  // Video (Phase 4b) — Pro-only, R2-backed
  veo: googleVideoAdapter,
  omni: googleOmniAdapter,
  kling: falAdapter,
  runway: runwayAdapter,
  seedance: falAdapter,
};

export function adapterFor(familyId: string): ProviderAdapter {
  const adapter = BY_FAMILY[familyId];
  if (!adapter) throw new Error(`no adapter for ${familyId}`);
  return adapter;
}

export type { ProviderAdapter, SubmitCtx, CheckResult } from './types.ts';
