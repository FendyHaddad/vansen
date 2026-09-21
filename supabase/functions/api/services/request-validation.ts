// The catalog is the contract. sanitizeSettings() proves a value is a
// well-formed string; this proves the selected family actually offers it, so a
// nonsense axis can never be priced by the providerCost() fallback and then
// charged for a request the provider will clamp or reject.
import { resolutionsFor } from '../_shared/model-families.ts';
import type { GenerationSettings, ModelFamily } from '../_shared/model-families.ts';

export interface SettingsError {
  field: 'version' | 'resolution' | 'quality' | 'aspectRatio' | 'durationS' | 'audio';
  value: string;
  allowed: string[];
}

function offered(
  field: SettingsError['field'],
  value: string | undefined,
  allowed: string[],
): SettingsError | null {
  if (value === undefined) return null;
  if (allowed.includes(value)) return null;
  return { field, value, allowed };
}

export function validateSettings(
  family: ModelFamily,
  settings: GenerationSettings,
): SettingsError | null {
  const caps = family.capabilities;

  const version = offered('version', settings.version, caps.versions?.map((v) => v.value) ?? []);
  if (version) return version;

  const aspect = offered('aspectRatio', settings.aspectRatio, caps.aspectRatios);
  if (aspect) return aspect;

  // Checked after the ratio, because which tiers exist depends on it: FLUX.2
  // clamps every edge to 2048, so "4MP" is real at 1:1 and a lie at 16:9.
  const resolution = offered(
    'resolution',
    settings.resolution,
    caps.resolutions ? resolutionsFor(family, settings.aspectRatio).map((r) => r.value) : [],
  );
  if (resolution) return resolution;

  const quality = offered('quality', settings.quality, caps.qualities?.map((q) => q.value) ?? []);
  if (quality) return quality;

  const durations = caps.durations ?? [];
  if (settings.durationS !== undefined && !durations.includes(settings.durationS)) {
    return { field: 'durationS', value: String(settings.durationS), allowed: durations.map(String) };
  }

  if (settings.audio !== undefined && caps.audio !== 'selectable') {
    return { field: 'audio', value: settings.audio, allowed: [] };
  }

  return null;
}
