// A grid tile is 200 px. Serving a 4 MP PNG into it wastes the customer's
// bandwidth and ours, and it is the single biggest egress line the product
// has. Every finished image gets a 512 px JPEG alongside the original.
import { Image } from "jsr:@matmen/imagescript@1.3.1";

export const THUMB_MAX_EDGE = 512;
export const THUMB_QUALITY = 70;
export const THUMB_CONTENT_TYPE = "image/jpeg";

/** Formats this decoder handles. Anything else is recorded, not guessed at. */
const DECODABLE = new Set(["image/png", "image/jpeg", "image/jpg"]);

export class ThumbnailUnsupported extends Error {
  constructor(readonly contentType: string) {
    super(`thumbnail_format_unsupported:${contentType}`);
  }
}

export function canThumbnail(contentType: string): boolean {
  return DECODABLE.has(contentType.split(";")[0].trim().toLowerCase());
}

/** The path a generation's thumbnail lives at, beside its original. */
export function thumbPathFor(mediaPath: string): string {
  const cut = mediaPath.lastIndexOf(".");
  const stem = cut > 0 ? mediaPath.slice(0, cut) : mediaPath;
  return `${stem}.thumb.jpg`;
}

/**
 * Longest edge at most 512 px, aspect preserved, always JPEG.
 *
 * A smaller original is re-encoded rather than passed through: the caller
 * promises the bytes are a JPEG, and handing back an unchanged PNG under a
 * JPEG content type is how a tile ends up broken in one browser and fine in
 * another.
 */
export async function makeThumbnail(
  bytes: Uint8Array,
  contentType: string,
): Promise<Uint8Array> {
  if (!canThumbnail(contentType)) throw new ThumbnailUnsupported(contentType);
  const image = await Image.decode(bytes);
  const scale = Math.min(
    1,
    THUMB_MAX_EDGE / Math.max(image.width, image.height),
  );
  if (scale < 1) {
    image.resize(
      Math.max(1, Math.round(image.width * scale)),
      Math.max(1, Math.round(image.height * scale)),
    );
  }
  return await image.encodeJPEG(THUMB_QUALITY);
}
