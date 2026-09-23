/**
 * Option lists several families reuse: the image and video aspect ratios and
 * the 1K/2K/4K resolution tooltips. Internal to the catalog — the barrel
 * (model-families.ts) does not re-export them.
 */

export const AR_IMAGE = ['1:1', '3:4', '4:3', '16:9', '9:16'];

export const AR_VIDEO = ['16:9', '9:16', '1:1'];

export const RES_TOOLTIPS: Record<string, string> = {
  '1K': 'Output size ~1024px. Resolution is pixel count — not detail effort.',
  '2K': 'Output size ~2048px. Sharper for print and zooming; same content quality.',
  '4K': 'Output size ~3840px. Largest files, highest cost.',
};
