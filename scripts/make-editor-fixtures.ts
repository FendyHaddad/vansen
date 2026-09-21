#!/usr/bin/env -S deno run --allow-write --allow-read --allow-net
// Deterministic test images for the editor verification matrix (P7 Task 6).
//
// The fixtures are generated rather than committed: every one is a pure
// function of its name, so anyone can reproduce byte-identical files and
// check them against the SHA-256s in docs/verification/editor-fixtures.json.
// That also keeps ~10 MB of PNGs out of the repository, and sidesteps the
// licensing question that a downloaded photograph would raise — every pixel
// here is ours.
//
//   deno run --allow-write --allow-read --allow-net \
//     scripts/make-editor-fixtures.ts [outDir]
import { Image } from "jsr:@matmen/imagescript@1.3.1";
import { encodeHex } from "jsr:@std/encoding@1/hex";

/** Deterministic, seedable noise — no Math.random anywhere in this file. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

type Builder = (image: Image) => void;

interface Fixture {
  name: string;
  width: number;
  height: number;
  alpha: boolean;
  purpose: string;
  build: Builder;
}

const set = (img: Image, x: number, y: number, r: number, g: number, b: number, a = 255) =>
  img.setPixelAt(x + 1, y + 1, Image.rgbaToColor(r | 0, g | 0, b | 0, a | 0));

export const FIXTURES: Fixture[] = [
  {
    name: "color-chart",
    width: 600,
    height: 400,
    alpha: false,
    purpose: "Colour accuracy for adjust, levels, filters and enhance.",
    build: (img) => {
      const patches = [
        [115, 82, 68], [194, 150, 130], [98, 122, 157], [87, 108, 67],
        [133, 128, 177], [103, 189, 170], [214, 126, 44], [80, 91, 166],
        [193, 90, 99], [94, 60, 108], [157, 188, 64], [224, 163, 46],
        [56, 61, 150], [70, 148, 73], [175, 54, 60], [231, 199, 31],
        [187, 86, 149], [8, 133, 161], [243, 243, 242], [200, 200, 200],
        [160, 160, 160], [122, 122, 121], [85, 85, 85], [52, 52, 52],
      ];
      for (let y = 0; y < 400; y++) {
        for (let x = 0; x < 600; x++) {
          const col = Math.min(5, Math.floor(x / 100));
          const row = Math.min(3, Math.floor(y / 100));
          const [r, g, b] = patches[row * 6 + col];
          set(img, x, y, r, g, b);
        }
      }
    },
  },
  {
    name: "checkerboard",
    width: 512,
    height: 512,
    alpha: false,
    purpose: "Tile seams in upscale and sharpen; geometry in crop and rotate.",
    build: (img) => {
      for (let y = 0; y < 512; y++) {
        for (let x = 0; x < 512; x++) {
          const on = ((x >> 3) + (y >> 3)) % 2 === 0;
          set(img, x, y, on ? 240 : 16, on ? 240 : 16, on ? 240 : 16);
        }
      }
    },
  },
  {
    name: "landscape-nonsquare",
    width: 900,
    height: 400,
    alpha: false,
    purpose: "Non-square aspect through every resize, proxy and mask path.",
    build: (img) => {
      for (let y = 0; y < 400; y++) {
        for (let x = 0; x < 900; x++) {
          const sky = y < 200;
          set(img, x, y, sky ? 120 + (y >> 2) : 60 + (x % 40), sky ? 160 : 90, sky ? 220 : 50);
        }
      }
    },
  },
  {
    name: "fine-hair",
    width: 512,
    height: 512,
    alpha: false,
    purpose: "Matte quality at hair-scale detail for cut out and smart select.",
    build: (img) => {
      const next = rng(7);
      for (let y = 0; y < 512; y++) {
        for (let x = 0; x < 512; x++) {
          const head = (x - 256) ** 2 + (y - 300) ** 2 < 130 ** 2;
          const strand = Math.sin(x * 0.7 + y * 0.05) > 0.82 && y < 320 && y > 120;
          const on = head || strand;
          const n = next() * 20;
          set(img, x, y, on ? 70 + n : 230, on ? 55 + n : 230, on ? 45 + n : 235);
        }
      }
    },
  },
  {
    name: "transparent-edge",
    width: 400,
    height: 400,
    alpha: true,
    purpose: "Alpha survival through filters, upscale and PNG/WebP export.",
    build: (img) => {
      for (let y = 0; y < 400; y++) {
        for (let x = 0; x < 400; x++) {
          const d = Math.hypot(x - 200, y - 200);
          const a = d > 180 ? 0 : d > 150 ? Math.round((180 - d) * 8.5) : 255;
          set(img, x, y, 220, 90, 60, a);
        }
      }
    },
  },
  {
    name: "blurred",
    width: 640,
    height: 480,
    alpha: false,
    purpose: "AI Sharpen and dehaze have something to actually recover.",
    build: (img) => {
      for (let y = 0; y < 480; y++) {
        for (let x = 0; x < 640; x++) {
          const edge = 1 / (1 + Math.exp(-(x - 320) / 40));
          const v = 40 + edge * 170;
          set(img, x, y, v, v * 0.9, v * 0.8);
        }
      }
    },
  },
  {
    name: "flat-colour",
    width: 512,
    height: 512,
    alpha: false,
    purpose: "Nothing to enhance: a tool that changes this is hallucinating.",
    build: (img) => {
      for (let y = 0; y < 512; y++) {
        for (let x = 0; x < 512; x++) set(img, x, y, 128, 128, 128);
      }
    },
  },
  {
    name: "noisy-lowlight",
    width: 640,
    height: 480,
    alpha: false,
    purpose: "Denoise, portrait smooth and bokeh under real sensor noise.",
    build: (img) => {
      const next = rng(19);
      for (let y = 0; y < 480; y++) {
        for (let x = 0; x < 640; x++) {
          const base = 18 + (x / 640) * 30;
          const n = (next() - 0.5) * 46;
          set(img, x, y, base + n, base * 0.9 + n, base * 1.2 + n);
        }
      }
    },
  },
  {
    name: "large-4k",
    width: 4096,
    height: 2304,
    alpha: false,
    purpose: "The accepted upscale cap, memory ceilings and proxy behaviour.",
    build: (img) => {
      for (let y = 0; y < 2304; y++) {
        for (let x = 0; x < 4096; x++) {
          set(img, x, y, (x >> 4) % 256, (y >> 4) % 256, ((x + y) >> 5) % 256);
        }
      }
    },
  },
];

async function sha256(bytes: Uint8Array): Promise<string> {
  return encodeHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)));
}

if (import.meta.main) {
  const outDir = Deno.args[0] ?? "docs/verification/fixtures";
  await Deno.mkdir(outDir, { recursive: true });
  const manifest = [];
  for (const fixture of FIXTURES) {
    const image = new Image(fixture.width, fixture.height);
    fixture.build(image);
    const bytes = await image.encode();
    const path = `${outDir}/${fixture.name}.png`;
    await Deno.writeFile(path, bytes);
    manifest.push({
      name: fixture.name,
      path,
      sha256: await sha256(bytes),
      bytes: bytes.length,
      width: fixture.width,
      height: fixture.height,
      alpha: fixture.alpha,
      purpose: fixture.purpose,
      provenance: "Generated by scripts/make-editor-fixtures.ts — original work, no license restrictions.",
    });
    console.log(`${fixture.name}: ${fixture.width}x${fixture.height}, ${bytes.length} bytes`);
  }
  console.log(JSON.stringify(manifest, null, 2));
}
