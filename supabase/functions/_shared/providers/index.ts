import { ProviderAdapter } from './types.ts';
import { falAdapter } from './fal.ts';
import { googleAdapter } from './google.ts';
import { openaiAdapter } from './openai.ts';

const BY_FAMILY: Record<string, ProviderAdapter> = {
  'nano-banana': googleAdapter,
  'gpt-image': openaiAdapter,
  flux: falAdapter,
  seedream: falAdapter,
  upscaler: falAdapter,
  // Studio panel AI edit tools — all fal (FLUX fill + BiRefNet)
  'edit-remove': falAdapter,
  'edit-fill': falAdapter,
  'edit-expand': falAdapter,
  'edit-bg': falAdapter,
};

export function adapterFor(familyId: string): ProviderAdapter {
  const adapter = BY_FAMILY[familyId];
  if (!adapter) throw new Error(`no adapter for ${familyId}`);
  return adapter;
}

export type { ProviderAdapter, SubmitCtx, CheckResult } from './types.ts';
