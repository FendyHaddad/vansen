import { PERSONA_MIN_EDGE } from '../catalog/model-families';

export const PERSONA_MAX_EDGE = 2048;
const JPEG_QUALITY = 0.92;

export class PhotoTooSmallError extends Error {
  constructor() {
    super('photo_too_small');
  }
}

/** Target dimensions fitting inside maxEdge, never upscaling. */
export function fitWithin(
  width: number,
  height: number,
  maxEdge = PERSONA_MAX_EDGE,
): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export function isTooSmall(width: number, height: number): boolean {
  return Math.min(width, height) < PERSONA_MIN_EDGE;
}

/** Keep a sharp photo sharp: refuse small ones, cap big ones at 2048px, JPEG 0.92. */
export async function prepPhoto(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  if (isTooSmall(bitmap.width, bitmap.height)) {
    bitmap.close();
    throw new PhotoTooSmallError();
  }
  const { width, height } = fitWithin(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY),
  );
  if (!blob) throw new Error('photo encode failed');
  return blob;
}
