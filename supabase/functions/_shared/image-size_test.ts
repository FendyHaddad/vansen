import { assertEquals } from 'jsr:@std/assert';
import { imageSize } from './image-size.ts';

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function jpeg(width: number, height: number): Uint8Array {
  // SOI, then one SOF0 segment: FF C0, length 0x0011, precision, height, width.
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0x03]);
  const view = new DataView(bytes.buffer);
  view.setUint16(7, height);
  view.setUint16(9, width);
  return bytes;
}

Deno.test('reads png dimensions from IHDR', () => {
  assertEquals(imageSize(png(1920, 1080)), { width: 1920, height: 1080 });
});

Deno.test('reads jpeg dimensions from SOF0', () => {
  assertEquals(imageSize(jpeg(800, 600)), { width: 800, height: 600 });
});

Deno.test('unknown bytes return null', () => {
  assertEquals(imageSize(new Uint8Array([1, 2, 3, 4])), null);
});

Deno.test('truncated png returns null rather than guessing', () => {
  assertEquals(imageSize(png(10, 10).slice(0, 12)), null);
});
