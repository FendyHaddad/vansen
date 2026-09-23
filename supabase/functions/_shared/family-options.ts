/**
 * What one family really offers once its per-ratio and per-version limits are
 * applied, and the settings a new generation starts from. The composer and
 * the gateway both call these, so the UI and the server agree.
 * Entry points: resolutionsFor, qualitiesFor, defaultSettings.
 */
import type { FamilyOption, GenerationSettings, ModelFamily } from './family-types.ts';

/**
 * The resolution tiers a family really offers at one aspect ratio.
 *
 * The composer and the server both ask this, so a stale client cannot buy a
 * tier the provider would clamp: the chip is absent in the UI and the request
 * is refused before charge.
 */
export function resolutionsFor(
  family: ModelFamily,
  aspectRatio: string,
  version?: string,
): FamilyOption[] {
  const all = family.capabilities.resolutions ?? [];
  const excluded = family.capabilities.resolutionExclusions?.[aspectRatio];
  const byRatio = excluded ? all.filter((o) => !excluded.includes(o.value)) : all;
  const allowed = version ? family.capabilities.versionResolutions?.[version] : undefined;
  if (!allowed) return byRatio;
  return byRatio.filter((o) => allowed.includes(o.value));
}

/**
 * The quality settings one version of a family really accepts.
 *
 * Same reason as `resolutionsFor`: a quality one version accepts and another
 * rejects must not be offered or priced where the provider would refuse it.
 */
export function qualitiesFor(family: ModelFamily, version?: string): FamilyOption[] {
  const all = family.capabilities.qualities ?? [];
  const allowed = version ? family.capabilities.versionQualities?.[version] : undefined;
  if (!allowed) return all;
  return all.filter((o) => allowed.includes(o.value));
}

export function defaultSettings(family: ModelFamily): GenerationSettings {
  const c = family.capabilities;
  const defaultVersion = c.versions?.find((v) => v.isDefault)
    ?? c.versions?.find((v) => v.tag === 'Latest')
    ?? c.versions?.[0];
  const base: GenerationSettings = {
    version: defaultVersion?.value,
    aspectRatio: c.aspectRatios[0],
    resolution: c.resolutions?.[0]?.value,
    quality: c.qualities ? 'medium' : undefined,
    durationS: c.durations?.[0],
    batch: 1,
  };
  if (family.kind !== 'video') return base;
  base.mode = 't2v';
  if (c.audio === 'selectable') base.audio = 'off';
  return base;
}
