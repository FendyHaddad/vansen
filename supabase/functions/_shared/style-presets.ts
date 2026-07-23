/**
 * Style presets — prompt boosters for image generation.
 * MASTER copy. The edge functions consume a synced copy in
 * supabase/functions/_shared/ (npm run sync-shared).
 * Style is free: pure prompt text, no pricing impact.
 */

export type StyleCategory = 'art' | 'anime' | 'photo' | 'stylized';

export interface StylePreset {
  id: string;
  name: string;
  category: StyleCategory;
  /** Appended to the user's prompt as `, ${modifier}` at generation time. */
  modifier: string;
  /** Thumbnail asset path (public/styles/<id>.webp served at /styles/). */
  thumb: string;
}

export const STYLE_CATEGORY_TITLES: Record<StyleCategory, string> = {
  art: 'Art media',
  anime: 'Anime & comic',
  photo: 'Photo looks',
  stylized: 'Stylized',
};

const p = (
  id: string,
  name: string,
  category: StyleCategory,
  modifier: string,
): StylePreset => ({ id, name, category, modifier, thumb: `/styles/${id}.webp` });

export const STYLE_PRESETS: StylePreset[] = [
  // Art media
  p('oil-painting', 'Oil painting', 'art', 'oil painting, visible brushstrokes, canvas texture, rich impasto color'),
  p('watercolor', 'Watercolor', 'art', 'watercolor painting, soft washes, bleeding pigment, paper texture'),
  p('pencil-sketch', 'Pencil sketch', 'art', 'pencil sketch, graphite shading, cross-hatching, sketchbook drawing'),
  p('3d-render', '3D render', 'art', 'polished 3D render, global illumination, soft studio lighting, smooth surfaces'),
  p('pixel-art', 'Pixel art', 'art', 'pixel art, 16-bit retro game sprite, limited palette, crisp pixels'),
  // Anime & comic
  p('anime', 'Anime', 'anime', 'anime style, clean line art, cel shading, vibrant colors'),
  p('manga', 'Manga', 'anime', 'black and white manga panel, screentone shading, dynamic ink lines'),
  p('comic-book', 'Comic book', 'anime', 'western comic book art, bold ink outlines, halftone dots, dramatic shading'),
  p('cartoon', 'Cartoon', 'anime', 'playful cartoon style, thick outlines, flat bright colors, exaggerated shapes'),
  p('soft-anime', 'Soft anime', 'anime', 'soft anime film style, painterly backgrounds, gentle pastel light, wistful mood'),
  // Photo looks
  p('realistic-photo', 'Realistic photo', 'photo', 'photorealistic, natural lighting, sharp focus, high detail photography'),
  p('cinematic', 'Cinematic', 'photo', 'cinematic still, anamorphic lens, dramatic lighting, film grain, shallow depth of field'),
  p('portrait-studio', 'Portrait studio', 'photo', 'studio portrait, softbox lighting, seamless backdrop, 85mm lens, crisp detail'),
  p('analog-film', 'Analog film', 'photo', 'analog 35mm film photo, fine grain, faded highlights, vintage color tones'),
  p('bw-noir', 'B&W noir', 'photo', 'black and white noir photograph, hard shadows, high contrast, moody atmosphere'),
  // Stylized
  p('cyberpunk', 'Cyberpunk', 'stylized', 'cyberpunk scene, neon lights, rain-slick streets, holographic glow, night city'),
  p('fantasy-art', 'Fantasy art', 'stylized', 'epic fantasy art, ornate detail, dramatic light, painterly concept art'),
  p('vaporwave', 'Vaporwave', 'stylized', 'vaporwave aesthetic, pink and teal palette, retro 80s grid, chrome accents'),
  p('pop-art', 'Pop art', 'stylized', 'pop art, ben-day dots, bold flat colors, thick outlines, screen print look'),
  p('minimalist-flat', 'Minimalist flat', 'stylized', 'minimalist flat illustration, simple geometric shapes, limited palette, clean vector look'),
];

export function styleById(id: string): StylePreset | null {
  return STYLE_PRESETS.find((s) => s.id === id) ?? null;
}

/** Boost a prompt with a style modifier. Unknown/absent style = prompt unchanged. */
export function applyStyle(prompt: string, styleId: string | null | undefined): string {
  const style = styleId ? styleById(styleId) : null;
  return style ? `${prompt}, ${style.modifier}` : prompt;
}
