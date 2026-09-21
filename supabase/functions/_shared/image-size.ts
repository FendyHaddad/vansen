// Pixel dimensions straight from the file header — no decoding, so a
// decompression bomb is rejected before anything allocates its pixels.
// Covers exactly the three types sniffImage() accepts.

export interface ImageSize {
  width: number;
  height: number;
}

function pngSize(bytes: Uint8Array, view: DataView): ImageSize | null {
  if (bytes.length < 24) return null;
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e &&
    bytes[3] === 0x47;
  if (!isPng) return null;
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function jpegSize(bytes: Uint8Array, view: DataView): ImageSize | null {
  if (bytes.length < 4) return null;
  if (!(bytes[0] === 0xff && bytes[1] === 0xd8)) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    const length = view.getUint16(offset + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 &&
      marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
    }
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

function webpSize(bytes: Uint8Array, view: DataView): ImageSize | null {
  if (bytes.length < 30) return null;
  const isRiff = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 &&
    bytes[3] === 0x46;
  const isWebp = bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 &&
    bytes[11] === 0x50;
  if (!isRiff || !isWebp) return null;
  const fourcc = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  if (fourcc === 'VP8X') {
    const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
    const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
    return { width, height };
  }
  if (fourcc === 'VP8L') {
    const bits = view.getUint32(21, true);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  if (fourcc === 'VP8 ') {
    return {
      width: view.getUint16(26, true) & 0x3fff,
      height: view.getUint16(28, true) & 0x3fff,
    };
  }
  return null;
}

export function imageSize(bytes: Uint8Array): ImageSize | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const png = pngSize(bytes, view);
  if (png) return png;
  const webp = webpSize(bytes, view);
  if (webp) return webp;
  return jpegSize(bytes, view);
}
