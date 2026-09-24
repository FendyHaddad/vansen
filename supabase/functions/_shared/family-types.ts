/**
 * The types every catalog module shares: a model family, its selectable
 * options, the settings a generation runs with and the inputs it carries.
 * Types only — no values — so any catalog file can import it without cycles.
 */

export type ModelKind = 'image' | 'video';
export type AxisId = 'version' | 'aspectRatio' | 'resolution' | 'quality' | 'duration' | 'audio';
export type VideoMode = 't2v' | 'i2v' | 'ref2v' | 'keyframes' | 'extend' | 'edit';
export type AudioMode = 'off' | 'on' | 'voice';
export type AudioCapability = 'included' | 'none' | 'selectable';

export interface FamilyOption {
  value: string;
  label: string;
  tooltip: string;
  /** Small highlight tag rendered on the chip, e.g. "Latest". Display only. */
  tag?: string;
  /**
   * The option `defaultSettings` picks. Separate from `tag` on purpose: until
   * 2026-09-22 the badge WAS the default marker, so adding a newer model moved
   * every new generation onto it as a side effect of labelling it. The newest
   * model and the one we are willing to put in front of someone by default are
   * different questions — a model with no smoke behind it can be offered
   * without being the thing everyone gets.
   */
  isDefault?: boolean;
}

export interface GenerationSettings {
  version?: string;
  aspectRatio: string;
  resolution?: string;
  quality?: string;
  durationS?: number;
  /** Outputs per run (1–4). Price multiplies per output. */
  batch?: number;
  /** Persona id used for this generation. Set server-side; likeness pipeline. */
  persona?: string;
  /** Trend preset id — stamped when the prompt came from a trend prefill. */
  trend?: string;
  /** Video audio selection, only meaningful when capabilities.audio === 'selectable'. */
  audio?: AudioMode;
  /** Video generation mode — text-to-video, image-to-video, extend, etc. */
  mode?: VideoMode;
  /** Conversational continuation id, for models that support edit/extend by reference. */
  interactionId?: string;
}

export interface ModelFamily {
  id: string;
  name: string;
  provider: string;
  logo: string;
  kind: ModelKind;
  blurb: string;
  capabilities: {
    versions?: FamilyOption[];
    aspectRatios: string[];
    resolutions?: FamilyOption[];
    /**
     * Resolution tiers this family cannot actually deliver at a given aspect
     * ratio, keyed by ratio. A tier the provider will clamp must not be
     * offered at a price that describes the unclamped size.
     */
    resolutionExclusions?: Record<string, string[]>;
    /**
     * Resolution tiers each version can actually produce, keyed by version.
     * A version absent from this map is unrestricted.
     *
     * This lives here as data because it used to live in the left panel as a
     * hardcoded GPT version check: adding GPT Image 2.5 on 2026-09-22 silently
     * withheld 2K and 4K from the two new models, which both support them.
     * Encoding the limit next to the versions it describes means adding a
     * version cannot quietly narrow the offer again. Seedream uses it for the
     * pixel window of each endpoint.
     */
    versionResolutions?: Record<string, string[]>;
    /**
     * Quality settings each version accepts, keyed by version. A version absent
     * from this map is unrestricted. Same contract as `versionResolutions`.
     */
    versionQualities?: Record<string, string[]>;
    qualities?: FamilyOption[];
    durations?: number[];
    audio?: AudioCapability;
    modes?: VideoMode[];
    /** Expected provider render seconds per output second, for wait-time estimates. */
    expectedSPerS?: number;
    imageInput: boolean;
    maskInput: boolean;
  };
  /** Provider cost of the OUTPUT alone, for these settings. */
  providerCost(settings: GenerationSettings): number;
  /**
   * Provider cost of the INPUT side: the prompt tokens and, when a reference
   * image rides along, the image input tokens. Absent means the provider bills
   * a flat price per output and inputs are free (fal's image endpoints).
   */
  inputCost?(input: GenerationInput, settings: GenerationSettings): number;
}

/** What the customer attached, as far as price is concerned. */
export interface GenerationInput {
  hasReference: boolean;
  /** How many reference images ride along. Absent means one when hasReference. */
  referenceCount?: number;
}
