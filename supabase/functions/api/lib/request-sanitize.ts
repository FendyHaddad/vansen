// Whitelisting sanitizers for request fields that are stored or priced.
// sanitizeSettings() cleans generation settings, sanitizePrefs() cleans
// profile prefs (unknown keys dropped, invalid values refuse the request).
// MAX_PROMPT_LEN is the catalog's prompt cap.
import {
  type GenerationSettings,
  PROMPT_MAX_CHARS,
  type VideoMode,
} from "../_shared/model-families.ts";

// The catalog owns the cap because it also prices it: every token-billed
// generation carries PROMPT_TOKEN_ALLOWANCE, sized for a prompt this long.
export const MAX_PROMPT_LEN = PROMPT_MAX_CHARS;
const AR_PATTERN = /^\d{1,2}:\d{1,2}$/;
const VIDEO_MODES: ReadonlySet<string> = new Set([
  "t2v",
  "i2v",
  "ref2v",
  "keyframes",
  "extend",
  "edit",
]);

/** Only known settings keys, type- and size-checked, are ever stored or priced. */
export function sanitizeSettings(raw: unknown): GenerationSettings {
  const src = (raw ?? {}) as Record<string, unknown>;
  const clean: GenerationSettings = { aspectRatio: "1:1" };
  if (typeof src.aspectRatio === "string" && AR_PATTERN.test(src.aspectRatio)) {
    clean.aspectRatio = src.aspectRatio;
  }
  if (typeof src.version === "string" && src.version.length <= 20) {
    clean.version = src.version;
  }
  if (typeof src.resolution === "string" && src.resolution.length <= 10) {
    clean.resolution = src.resolution;
  }
  if (typeof src.quality === "string" && src.quality.length <= 10) {
    clean.quality = src.quality;
  }
  if (
    typeof src.durationS === "number" &&
    Number.isFinite(src.durationS) &&
    src.durationS > 0 &&
    src.durationS <= 60
  ) {
    clean.durationS = src.durationS;
  }
  if (src.audio === "off" || src.audio === "on" || src.audio === "voice") {
    clean.audio = src.audio;
  }
  if (typeof src.mode === "string" && VIDEO_MODES.has(src.mode)) {
    clean.mode = src.mode as VideoMode;
  }
  return clean;
}

const PREF_CHECKS: ReadonlyArray<readonly [string, (v: unknown) => boolean]> = [
  ["defaultMode", (v) => v === "image" || v === "video"],
  ["defaultImageFamily", (v) => typeof v === "string" && v.length <= 40],
  ["defaultVideoFamily", (v) => typeof v === "string" && v.length <= 40],
  ["defaultVideoMode", (v) => typeof v === "string" && VIDEO_MODES.has(v)],
  ["defaultAspect", (v) => typeof v === "string" && v.length <= 10],
  ["defaultStyle", (v) => typeof v === "string" && v.length <= 40],
  ["defaultPersona", (v) => typeof v === "string" && v.length <= 40],
  ["tourSeen", (v) => typeof v === "boolean"],
];

/** Whitelist prefs: unknown keys dropped, invalid values reject the request. */
export function sanitizePrefs(
  raw: Record<string, unknown>,
): Record<string, unknown> | null {
  const clean: Record<string, unknown> = {};
  for (const [key, check] of PREF_CHECKS) {
    if (!(key in raw)) continue;
    if (!check(raw[key])) return null;
    clean[key] = raw[key];
  }
  return clean;
}
