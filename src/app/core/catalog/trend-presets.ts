/**
 * Trend presets — curated persona prompt templates ("trending" gallery).
 * CLIENT-ONLY: picking a trend prefills the editable prompt box; the server
 * never sees a trend id. Templates are persona-neutral — the persona trigger
 * word is injected server-side exactly as for free-form prompts.
 */

export interface TrendPreset {
  id: string;
  name: string;
  /** Prefilled into the prompt box (editable). */
  prompt: string;
  /** Example-output thumbnail (public/trends/<id>.webp served at /trends/). */
  thumb: string;
  /** Suggested aspect ratio applied on pick; user can change it. */
  aspectRatio?: string;
}

const t = (id: string, name: string, prompt: string, aspectRatio?: string): TrendPreset => ({
  id,
  name,
  prompt,
  thumb: `/trends/${id}.webp`,
  aspectRatio,
});

export const TREND_PRESETS: TrendPreset[] = [
  t('90s-yearbook', '90s Yearbook', 'portrait as a 1990s high school yearbook photo, retro laser beam studio backdrop, soft focus, vintage color grade, feathered hairstyle', '3:4'),
  t('action-figure', 'Action Figure', 'as a boxed action figure toy in blister pack packaging, accessories in molded tray, product photography on a toy store shelf', '3:4'),
  t('astronaut', 'Astronaut', 'as an astronaut in a detailed white space suit, helmet under one arm, dramatic lighting inside a space station, Earth visible through the window', '3:4'),
  t('anime-portrait', 'Anime Portrait', 'wholesome hand-painted anime film style portrait, painterly meadow background, gentle warm light, soft wind in the hair', '3:4'),
  t('renaissance', 'Renaissance', 'renaissance oil painting portrait in period noble clothing, chiaroscuro lighting, ornate gilded frame, museum quality', '3:4'),
  t('cyberpunk-street', 'Cyberpunk', 'standing in a neon-lit cyberpunk street at night, holographic signs, rain-slick pavement, cinematic teal and magenta glow', '3:4'),
  t('red-carpet', 'Red Carpet', 'on a red carpet at a film premiere, elegant evening wear, paparazzi camera flashes, glamour photography', '3:4'),
  t('linkedin-headshot', 'Pro Headshot', 'professional corporate headshot, tailored blazer, softbox studio lighting, neutral gray backdrop, confident natural smile', '1:1'),
  t('doll-box', 'Doll Box', 'as a fashion doll inside retail box packaging, pastel pink accents, matching accessories in a molded tray, glossy product shot', '3:4'),
  t('pixel-avatar', 'Pixel Avatar', 'as a 16-bit pixel art game character, sprite style, limited retro palette, simple scenic game background', '1:1'),
  t('movie-poster', 'Movie Poster', 'as the hero on a dramatic action movie poster, bold title typography, explosion backdrop, cinematic teal-orange grade', '3:4'),
  t('medieval-knight', 'Knight', 'as a medieval knight in polished plate armor, castle courtyard at golden hour, epic fantasy lighting', '3:4'),
];

export function trendById(id: string): TrendPreset | null {
  return TREND_PRESETS.find((p) => p.id === id) ?? null;
}
