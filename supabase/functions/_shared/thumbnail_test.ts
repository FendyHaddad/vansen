import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import { Image } from "jsr:@matmen/imagescript@1.3.1";
import {
  canThumbnail,
  makeThumbnail,
  THUMB_MAX_EDGE,
  ThumbnailUnsupported,
  thumbPathFor,
} from "./thumbnail.ts";

/** A PNG of the given size with enough variation to survive JPEG encoding. */
async function png(width: number, height: number): Promise<Uint8Array> {
  const image = new Image(width, height);
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) {
      image.setPixelAt(x + 1, y + 1, Image.rgbaToColor(x % 256, y % 256, 128, 255));
    }
  }
  return await image.encode();
}

Deno.test("a large image is capped at the long edge", async () => {
  const thumb = await makeThumbnail(await png(2000, 1000), "image/png");
  const decoded = await Image.decode(thumb);
  assertEquals(Math.max(decoded.width, decoded.height), THUMB_MAX_EDGE);
});

Deno.test("the aspect ratio survives the resize", async () => {
  const thumb = await makeThumbnail(await png(1600, 900), "image/png");
  const decoded = await Image.decode(thumb);
  const before = 1600 / 900;
  const after = decoded.width / decoded.height;
  assert(
    Math.abs(before - after) < 0.01,
    `aspect drifted: ${before} -> ${after}`,
  );
});

Deno.test("the thumbnail is smaller than the original it replaces", async () => {
  const original = await png(2000, 1000);
  const thumb = await makeThumbnail(original, "image/png");
  assert(
    thumb.length < original.length,
    `thumbnail ${thumb.length} is not smaller than ${original.length}`,
  );
});

Deno.test("an already-small image keeps its size but becomes a JPEG", async () => {
  const thumb = await makeThumbnail(await png(64, 48), "image/png");
  const decoded = await Image.decode(thumb);
  assertEquals([decoded.width, decoded.height], [64, 48]);
  // SOI marker: the bytes really are JPEG, not a PNG wearing the label.
  assertEquals([thumb[0], thumb[1]], [0xff, 0xd8]);
});

Deno.test("a format this decoder cannot read is refused, not guessed at", async () => {
  await assertRejects(
    () => makeThumbnail(new Uint8Array([1, 2, 3]), "image/webp"),
    ThumbnailUnsupported,
  );
  assertEquals(canThumbnail("image/webp"), false);
  assertEquals(canThumbnail("image/png"), true);
  assertEquals(canThumbnail("image/jpeg; charset=binary"), true);
});

Deno.test("corrupt bytes throw rather than returning an empty thumbnail", async () => {
  await assertRejects(() =>
    makeThumbnail(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]), "image/png")
  );
});

Deno.test("the thumbnail sits beside the original", () => {
  assertEquals(thumbPathFor("user/g1-0.png"), "user/g1-0.thumb.jpg");
  assertEquals(thumbPathFor("user/no-extension"), "user/no-extension.thumb.jpg");
});
