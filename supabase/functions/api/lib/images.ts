// Upload limits and magic-byte image sniffing, shared by every route that
// accepts image bytes (uploads, masks, thumbnails, saved edits, imports).

export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

/** Pre-allocation guard: nothing downstream needs more than 50 MP, and a larger
 * header is a decompression bomb, not a photo. */
export const UPLOAD_MAX_PIXELS = 50 * 1_000_000;

/** Detect image type from magic bytes; returns extension or null. */
export function sniffImage(bytes: Uint8Array): "png" | "jpg" | "webp" | null {
  if (
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "webp";
  }
  return null;
}
