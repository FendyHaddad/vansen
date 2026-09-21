/**
 * The sizes the editor will accept, and the one place that decides.
 *
 * Every local tool allocates buffers proportional to the image: a check that
 * happens after the allocation is not a check, it is a post-mortem. These are
 * pure functions so the guard can run before a canvas, a tensor or an ONNX
 * session exists.
 */
export interface PixelPolicy {
  maxInputPixels: number;
  maxOutputPixels: number;
}

/**
 * Provisional production limits.
 *
 * 40 MP in (roughly 7700x5200) and 80 MP out covers every output the product
 * can currently generate, with room for a customer's own upload. Task 6's
 * lower-memory device measurements decide the final numbers; until those
 * exist these are the honest guess, kept in one place so they move together.
 */
export const EDITOR_PIXEL_POLICY: PixelPolicy = {
  maxInputPixels: 40_000_000,
  maxOutputPixels: 80_000_000,
};

/**
 * A size refusal, separate from every other failure so the UI can show the
 * customer-facing sentence rather than "Engine error: ...".
 */
export class PixelBudgetError extends Error {}

export function assertPixelBudget(
  width: number,
  height: number,
  scale: number,
  policy: PixelPolicy,
): void {
  if (![width, height, scale].every((n) => Number.isSafeInteger(n) && n > 0)) {
    throw new PixelBudgetError('Image dimensions must be positive whole numbers.');
  }
  const input = width * height;
  const output = input * scale * scale;
  if (!Number.isSafeInteger(input) || !Number.isSafeInteger(output)) {
    throw new PixelBudgetError('Image dimensions exceed the supported size.');
  }
  if (input > policy.maxInputPixels || output > policy.maxOutputPixels) {
    throw new PixelBudgetError('This image exceeds the supported editing size.');
  }
}

/** Upscale doubles each edge, so its output budget is four times its input. */
export function upscalePolicy(maxInputPixels: number): PixelPolicy {
  return { maxInputPixels, maxOutputPixels: maxInputPixels * 4 };
}

/**
 * Longest edge of the buffer previews run on.
 *
 * A preview exists to answer "does this look right", and a 4 MP answer is no
 * more informative than a 1 MP one — it just costs seconds of inference and
 * hundreds of megabytes per slider drag.
 */
export const PREVIEW_MAX_DIM = 1100;

/** Debounce for ONNX-backed previews; cheaper ops coalesce per frame. */
export const HEAVY_PREVIEW_DEBOUNCE_MS = 150;

export interface Point {
  x: number;
  y: number;
}

/**
 * Moves a point from full-image space into proxy space.
 *
 * The customer clicks a focus point on the full image; the preview runs on a
 * smaller copy. Passing the unscaled point would focus a different part of
 * the picture than the one they tapped — and only in the preview, so the
 * commit would silently disagree with it.
 */
export function scalePoint(point: Point | null, scale: number): Point | null {
  if (!point) return null;
  return { x: point.x * scale, y: point.y * scale };
}
