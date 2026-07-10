# Studio Editing Panel Implementation Plan (Phase 3b)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Photoshop-lite editing panel in the workspace: free local canvas tools + fixed-price AI edit tools, gated to Studio subscribers, per spec `docs/superpowers/specs/2026-07-09-studio-editing-panel-design.md`.

**Architecture:** Pure-TS pixel engine (`src/app/core/editing/`) operating on a DOM-free `PixelBuffer`, driven by a signal-based `EditSession`; workspace gains an edit mode (grid ↔ canvas swap) with the existing left AI rail and a new right Studio panel; backend adds `POST /edits/save` and four fixed-price edit tools that ride the entire Phase 3a pipeline (charge RPC, jobs, refunds, moderation, kill switch).

**Tech Stack:** Angular 22 (standalone, signals, OnPush, zoneless), spartan/ui, vitest, Supabase Edge Functions (Deno + Hono), fal.ai (FLUX fill + BiRefNet), OpenCV.js (`@techstark/opencv-js`, lazy).

## Global Constraints

- **NEVER run `git commit`, `git branch`, or `git push`. The user makes all commits personally.** Where this plan's task template would say "Commit", instead STOP and report the task done.
- Angular components always use separate files: `.ts` + `.html` + `.css`. Never inline templates or styles. Prefer stylesheet classes over inline `style` attributes.
- Build: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use 22.23.1 >/dev/null && npx ng build`
- Tests: same nvm preamble then `npx vitest run`
- After any change to `src/app/core/enums.ts` or `src/app/core/catalog/model-families.ts`: run `npm run sync-shared` (regenerates `supabase/functions/_shared/`), then redeploy the `api` Edge Function via Supabase MCP `deploy_edge_function` bundling EVERY `_shared/` file including `providers/`.
- Supabase project ref `bnorhcxhvxydkgvcxjad`. Migrations applied via MCP `execute_sql`; also appended to `supabase/migrations/` as the schema record.
- No provider/Stripe keys in the repo — Edge Function secrets only.
- tsconfig uses `noPropertyAccessFromIndexSignature`: index-signature properties must use bracket access (`row['id']`, `RES_TOOLTIPS['1K']`).
- Fixed retail prices (NOT the PAYG margin formula): remove/fill/expand $0.10 each, background removal $0.05.

---

### Task 1: EDIT_TOOLS catalog

**Files:**
- Modify: `src/app/core/catalog/model-families.ts` (append after `UPSCALER`, ~line 302)
- Test: `src/app/core/catalog/model-families.spec.ts`

**Interfaces:**
- Produces: `EditTool` interface, `EDIT_TOOLS: EditTool[]`, `editToolById(id: string): EditTool | undefined` — consumed by the studio panel (Task 6/7) and, via sync-shared, by the gateway (Task 5).

- [ ] **Step 1: Write the failing tests** — append to `model-families.spec.ts`:

```ts
import { EDIT_TOOLS, editToolById } from './model-families';

describe('EDIT_TOOLS', () => {
  it('carries the four fixed-price studio AI tools', () => {
    expect(EDIT_TOOLS.map((t) => t.id)).toEqual([
      'edit-remove',
      'edit-fill',
      'edit-expand',
      'edit-bg',
    ]);
  });

  it('uses fixed retail prices, not the margin formula', () => {
    expect(editToolById('edit-remove')?.userPriceUsd).toBe(0.1);
    expect(editToolById('edit-fill')?.userPriceUsd).toBe(0.1);
    expect(editToolById('edit-expand')?.userPriceUsd).toBe(0.1);
    expect(editToolById('edit-bg')?.userPriceUsd).toBe(0.05);
  });

  it('marks mask and prompt requirements per tool', () => {
    expect(editToolById('edit-remove')).toMatchObject({ needsMask: true, needsPrompt: false });
    expect(editToolById('edit-fill')).toMatchObject({ needsMask: true, needsPrompt: true });
    expect(editToolById('edit-expand')).toMatchObject({ needsMask: false, needsPrompt: false });
    expect(editToolById('edit-bg')).toMatchObject({ needsMask: false, needsPrompt: false });
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/app/core/catalog/model-families.spec.ts` → FAIL (`EDIT_TOOLS` not exported).

- [ ] **Step 3: Implement** — append to `model-families.ts` after the `UPSCALER` block:

```ts
/**
 * Studio panel AI edit tools — fixed-function (one curated backend model each,
 * user never picks) with fixed retail prices (NOT the PAYG margin formula).
 */
export interface EditTool {
  id: string;
  name: string;
  /** What the user pays per use — fixed retail. */
  userPriceUsd: number;
  /** Our provider cost, for margin bookkeeping only. */
  providerCost: number;
  /** Tool needs a painted mask before it can run. */
  needsMask: boolean;
  /** Tool needs a user prompt (generative fill). */
  needsPrompt: boolean;
  blurb: string;
}

export const EDIT_TOOLS: EditTool[] = [
  {
    id: 'edit-remove',
    name: 'Remove Object',
    userPriceUsd: 0.1,
    providerCost: 0.05,
    needsMask: true,
    needsPrompt: false,
    blurb: 'Mask anything and AI repaints the scene behind it.',
  },
  {
    id: 'edit-fill',
    name: 'Generative Fill',
    userPriceUsd: 0.1,
    providerCost: 0.05,
    needsMask: true,
    needsPrompt: true,
    blurb: 'Mask an area and describe what should appear there.',
  },
  {
    id: 'edit-expand',
    name: 'Expand',
    userPriceUsd: 0.1,
    providerCost: 0.05,
    needsMask: false,
    needsPrompt: false,
    blurb: 'Grow the canvas — AI paints beyond the original edges.',
  },
  {
    id: 'edit-bg',
    name: 'Remove Background',
    userPriceUsd: 0.05,
    providerCost: 0.002,
    needsMask: false,
    needsPrompt: false,
    blurb: 'Cut the subject out onto a transparent background.',
  },
];

export function editToolById(id: string): EditTool | undefined {
  return EDIT_TOOLS.find((t) => t.id === id);
}
```

- [ ] **Step 4: Verify pass + sync** — `npx vitest run` → all pass. Then `npm run sync-shared` → confirms `supabase/functions/_shared/model-families.ts` regenerated (drift test guards this).

- [ ] **Step 5: Report task done** (no commit — user commits).

---

### Task 2: Pixel engine — buffer type + local ops

**Files:**
- Create: `src/app/core/editing/pixel-buffer.ts`
- Create: `src/app/core/editing/ops/adjust.ts`
- Create: `src/app/core/editing/ops/convolve.ts`
- Create: `src/app/core/editing/ops/crop.ts`
- Create: `src/app/core/editing/ops/liquify.ts`
- Test: `src/app/core/editing/ops/ops.spec.ts`

**Interfaces:**
- Produces:
  - `interface PixelBuffer { width: number; height: number; data: Uint8ClampedArray }` (RGBA, DOM-free — vitest runs it in node)
  - `clonePixels(buf: PixelBuffer): PixelBuffer`
  - `adjust(buf, { brightness, contrast, saturation }): PixelBuffer` — each −100..100, 0 = no-op
  - `sharpen(buf, amount: number): PixelBuffer` / `smooth(buf, amount: number): PixelBuffer` — amount 0..100
  - `crop(buf, { x, y, width, height }): PixelBuffer`
  - `rotate90(buf): PixelBuffer`
  - `liquify(buf, { cx, cy, radius, dx, dy }): PixelBuffer` — one brush-step push warp
- Consumed by: `EditEngine` (Task 3), worker (Task 3).

- [ ] **Step 1: Write failing tests** — `ops.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { PixelBuffer, clonePixels } from '../pixel-buffer';
import { adjust } from './adjust';
import { sharpen, smooth } from './convolve';
import { crop, rotate90 } from './crop';
import { liquify } from './liquify';

function solid(w: number, h: number, rgba: [number, number, number, number]): PixelBuffer {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
  return { width: w, height: h, data };
}

describe('adjust', () => {
  it('is identity at zero', () => {
    const src = solid(4, 4, [100, 150, 200, 255]);
    const out = adjust(src, { brightness: 0, contrast: 0, saturation: 0 });
    expect(Array.from(out.data)).toEqual(Array.from(src.data));
  });
  it('brightness shifts channels, alpha untouched', () => {
    const out = adjust(solid(2, 2, [100, 100, 100, 255]), {
      brightness: 50, contrast: 0, saturation: 0,
    });
    expect(out.data[0]).toBeGreaterThan(100);
    expect(out.data[3]).toBe(255);
  });
  it('saturation -100 produces gray (R=G=B)', () => {
    const out = adjust(solid(2, 2, [200, 50, 100, 255]), {
      brightness: 0, contrast: 0, saturation: -100,
    });
    expect(out.data[0]).toBe(out.data[1]);
    expect(out.data[1]).toBe(out.data[2]);
  });
});

describe('convolve', () => {
  it('sharpen/smooth at 0 are identity', () => {
    const src = solid(4, 4, [10, 20, 30, 255]);
    expect(Array.from(sharpen(src, 0).data)).toEqual(Array.from(src.data));
    expect(Array.from(smooth(src, 0).data)).toEqual(Array.from(src.data));
  });
  it('smooth pulls an outlier pixel toward neighbors', () => {
    const src = solid(3, 3, [0, 0, 0, 255]);
    src.data.set([255, 255, 255, 255], (1 * 3 + 1) * 4); // center white
    const out = smooth(src, 100);
    expect(out.data[(1 * 3 + 1) * 4]).toBeLessThan(255);
  });
  it('sharpen increases center-vs-neighbor contrast', () => {
    const src = solid(3, 3, [100, 100, 100, 255]);
    src.data.set([150, 150, 150, 255], (1 * 3 + 1) * 4);
    const out = sharpen(src, 100);
    expect(out.data[(1 * 3 + 1) * 4]).toBeGreaterThan(150);
  });
});

describe('crop / rotate', () => {
  it('crop extracts the requested region', () => {
    const src = solid(4, 4, [1, 2, 3, 255]);
    src.data.set([9, 9, 9, 255], (1 * 4 + 1) * 4); // pixel (1,1)
    const out = crop(src, { x: 1, y: 1, width: 2, height: 2 });
    expect(out.width).toBe(2);
    expect(out.height).toBe(2);
    expect(out.data[0]).toBe(9); // (1,1) is now (0,0)
  });
  it('rotate90 swaps dimensions and moves corners correctly', () => {
    const src = solid(2, 1, [0, 0, 0, 255]);
    src.data.set([9, 9, 9, 255], 0); // left pixel marked
    const out = rotate90(src);
    expect(out.width).toBe(1);
    expect(out.height).toBe(2);
    expect(out.data[0]).toBe(9); // top-left of a CW rotation = old bottom-left... (see impl contract)
  });
});

describe('liquify', () => {
  it('zero displacement is identity', () => {
    const src = solid(4, 4, [50, 60, 70, 255]);
    const out = liquify(src, { cx: 2, cy: 2, radius: 2, dx: 0, dy: 0 });
    expect(Array.from(out.data)).toEqual(Array.from(src.data));
  });
  it('pushes pixels inside the brush radius', () => {
    const src = solid(8, 8, [0, 0, 0, 255]);
    src.data.set([255, 255, 255, 255], (4 * 8 + 2) * 4); // white at (2,4)
    const out = liquify(src, { cx: 3, cy: 4, radius: 3, dx: 2, dy: 0 });
    expect(Array.from(out.data)).not.toEqual(Array.from(src.data));
  });
});

describe('clonePixels', () => {
  it('deep-copies', () => {
    const src = solid(2, 2, [1, 1, 1, 255]);
    const copy = clonePixels(src);
    copy.data[0] = 99;
    expect(src.data[0]).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify failure** — modules missing.

- [ ] **Step 3: Implement.**

`pixel-buffer.ts`:

```ts
/** DOM-free RGBA pixel grid — the unit every editing op consumes and returns. */
export interface PixelBuffer {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export function clonePixels(buf: PixelBuffer): PixelBuffer {
  return { width: buf.width, height: buf.height, data: new Uint8ClampedArray(buf.data) };
}
```

`ops/adjust.ts`:

```ts
import { PixelBuffer, clonePixels } from '../pixel-buffer';

export interface AdjustParams {
  /** −100..100 each; 0 = unchanged. */
  brightness: number;
  contrast: number;
  saturation: number;
}

/** Brightness/contrast/saturation in one pass. Alpha is never touched. */
export function adjust(buf: PixelBuffer, p: AdjustParams): PixelBuffer {
  if (p.brightness === 0 && p.contrast === 0 && p.saturation === 0) return clonePixels(buf);
  const out = clonePixels(buf);
  const d = out.data;
  const bShift = (p.brightness / 100) * 128;
  const cFactor = (259 * (p.contrast + 255)) / (255 * (259 - p.contrast));
  const sFactor = 1 + p.saturation / 100;
  for (let i = 0; i < d.length; i += 4) {
    let r = d[i], g = d[i + 1], b = d[i + 2];
    r += bShift; g += bShift; b += bShift;
    r = cFactor * (r - 128) + 128;
    g = cFactor * (g - 128) + 128;
    b = cFactor * (b - 128) + 128;
    const gray = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    r = gray + (r - gray) * sFactor;
    g = gray + (g - gray) * sFactor;
    b = gray + (b - gray) * sFactor;
    d[i] = r; d[i + 1] = g; d[i + 2] = b; // Uint8ClampedArray clamps
  }
  return out;
}
```

`ops/convolve.ts`:

```ts
import { PixelBuffer, clonePixels } from '../pixel-buffer';

/** 3×3 convolution, edge pixels clamped. Alpha untouched. */
function convolve3(buf: PixelBuffer, k: number[]): PixelBuffer {
  const { width: w, height: h, data: src } = buf;
  const out = clonePixels(buf);
  const d = out.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) {
        let acc = 0;
        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            const sx = Math.min(w - 1, Math.max(0, x + kx));
            const sy = Math.min(h - 1, Math.max(0, y + ky));
            acc += src[(sy * w + sx) * 4 + c] * k[(ky + 1) * 3 + (kx + 1)];
          }
        }
        d[(y * w + x) * 4 + c] = acc;
      }
    }
  }
  return out;
}

/** Blend between identity and a full-strength kernel by amount 0..100. */
function blended(buf: PixelBuffer, kernel: number[], amount: number): PixelBuffer {
  if (amount <= 0) return clonePixels(buf);
  const full = convolve3(buf, kernel);
  if (amount >= 100) return full;
  const t = amount / 100;
  const out = clonePixels(buf);
  for (let i = 0; i < out.data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      out.data[i + c] = buf.data[i + c] * (1 - t) + full.data[i + c] * t;
    }
  }
  return out;
}

export function sharpen(buf: PixelBuffer, amount: number): PixelBuffer {
  return blended(buf, [0, -1, 0, -1, 5, -1, 0, -1, 0], amount);
}

export function smooth(buf: PixelBuffer, amount: number): PixelBuffer {
  const n = 1 / 9;
  return blended(buf, [n, n, n, n, n, n, n, n, n], amount);
}
```

`ops/crop.ts`:

```ts
import { PixelBuffer } from '../pixel-buffer';

export interface CropRect { x: number; y: number; width: number; height: number }

export function crop(buf: PixelBuffer, r: CropRect): PixelBuffer {
  const x = Math.max(0, Math.floor(r.x));
  const y = Math.max(0, Math.floor(r.y));
  const w = Math.min(buf.width - x, Math.floor(r.width));
  const h = Math.min(buf.height - y, Math.floor(r.height));
  const data = new Uint8ClampedArray(w * h * 4);
  for (let row = 0; row < h; row++) {
    const srcStart = ((y + row) * buf.width + x) * 4;
    data.set(buf.data.subarray(srcStart, srcStart + w * 4), row * w * 4);
  }
  return { width: w, height: h, data };
}

/** Clockwise 90°: output (x,y) = input (y, H-1-x) — contract the test pins. */
export function rotate90(buf: PixelBuffer): PixelBuffer {
  const { width: w, height: h } = buf;
  const data = new Uint8ClampedArray(buf.data.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const src = (y * w + x) * 4;
      const dst = (x * h + (h - 1 - y)) * 4;
      data.set(buf.data.subarray(src, src + 4), dst);
    }
  }
  return { width: h, height: w, data };
}
```

(If the rotate corner assertion in the test contradicts this mapping, fix the TEST to match this documented contract — output (x,y) = input (y, H−1−x).)

`ops/liquify.ts`:

```ts
import { PixelBuffer, clonePixels } from '../pixel-buffer';

export interface LiquifyStep {
  /** Brush center in pixels. */
  cx: number;
  cy: number;
  radius: number;
  /** Drag vector for this step, pixels. */
  dx: number;
  dy: number;
}

/**
 * One push-brush step: pixels within radius sample backward along the drag
 * vector, faded by a smooth falloff — the classic warp Photoshop's forward
 * warp tool applies per pointer move. Bilinear sampling keeps edges smooth.
 */
export function liquify(buf: PixelBuffer, s: LiquifyStep): PixelBuffer {
  if (s.dx === 0 && s.dy === 0) return clonePixels(buf);
  const { width: w, height: h, data: src } = buf;
  const out = clonePixels(buf);
  const r2 = s.radius * s.radius;
  const x0 = Math.max(0, Math.floor(s.cx - s.radius));
  const x1 = Math.min(w - 1, Math.ceil(s.cx + s.radius));
  const y0 = Math.max(0, Math.floor(s.cy - s.radius));
  const y1 = Math.min(h - 1, Math.ceil(s.cy + s.radius));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dist2 = (x - s.cx) ** 2 + (y - s.cy) ** 2;
      if (dist2 >= r2) continue;
      const falloff = (1 - dist2 / r2) ** 2;
      const sx = Math.min(w - 1, Math.max(0, x - s.dx * falloff));
      const sy = Math.min(h - 1, Math.max(0, y - s.dy * falloff));
      const ix = Math.floor(sx), iy = Math.floor(sy);
      const fx = sx - ix, fy = sy - iy;
      const ix1 = Math.min(w - 1, ix + 1), iy1 = Math.min(h - 1, iy + 1);
      const di = (y * w + x) * 4;
      for (let c = 0; c < 4; c++) {
        const p00 = src[(iy * w + ix) * 4 + c];
        const p10 = src[(iy * w + ix1) * 4 + c];
        const p01 = src[(iy1 * w + ix) * 4 + c];
        const p11 = src[(iy1 * w + ix1) * 4 + c];
        out.data[di + c] =
          p00 * (1 - fx) * (1 - fy) + p10 * fx * (1 - fy) +
          p01 * (1 - fx) * fy + p11 * fx * fy;
      }
    }
  }
  return out;
}
```

- [ ] **Step 4: Run tests** — `npx vitest run src/app/core/editing` → PASS (fix rotate test to the documented contract if needed).

- [ ] **Step 5: Report task done.**

---

### Task 3: EditEngine (history) + heal + worker offload

**Files:**
- Create: `src/app/core/editing/edit-engine.ts`
- Create: `src/app/core/editing/ops/heal.ts`
- Create: `src/app/core/editing/edit-worker.ts`
- Test: `src/app/core/editing/edit-engine.spec.ts`
- Modify: `package.json` (add `@techstark/opencv-js`)

**Interfaces:**
- Consumes: everything from Task 2.
- Produces:
  - `class EditEngine { constructor(initial: PixelBuffer); readonly current: PixelBuffer; canUndo/canRedo: boolean; push(next: PixelBuffer): void; undo(): PixelBuffer | null; redo(): PixelBuffer | null; reset(initial: PixelBuffer): void }` — snapshot history, cap 20.
  - `heal(buf: PixelBuffer, mask: Uint8Array): Promise<PixelBuffer>` — mask is 1 byte/pixel (255 = heal here); lazy-loads OpenCV on first call.
  - `runOpInWorker(op: WorkerOp): Promise<PixelBuffer>` where `type WorkerOp = { kind: 'adjust'|'sharpen'|'smooth'|'liquify'|'crop'|'rotate90'; buffer: PixelBuffer; params: unknown }` — falls back to synchronous execution when `Worker` is unavailable (vitest).

- [ ] **Step 1: Install dep** — `npm i @techstark/opencv-js` (types included; WASM ships in the package, bundler code-splits on dynamic import).

- [ ] **Step 2: Write failing tests** — `edit-engine.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { PixelBuffer } from './pixel-buffer';
import { EditEngine } from './edit-engine';
import { runOpSync } from './edit-worker';

function px(v: number): PixelBuffer {
  return { width: 1, height: 1, data: new Uint8ClampedArray([v, v, v, 255]) };
}

describe('EditEngine history', () => {
  it('push/undo/redo round-trips', () => {
    const e = new EditEngine(px(1));
    e.push(px(2));
    e.push(px(3));
    expect(e.current.data[0]).toBe(3);
    expect(e.undo()!.data[0]).toBe(2);
    expect(e.undo()!.data[0]).toBe(1);
    expect(e.undo()).toBeNull();
    expect(e.redo()!.data[0]).toBe(2);
  });
  it('push clears the redo branch', () => {
    const e = new EditEngine(px(1));
    e.push(px(2));
    e.undo();
    e.push(px(9));
    expect(e.canRedo).toBe(false);
    expect(e.current.data[0]).toBe(9);
  });
  it('caps history at 20 snapshots', () => {
    const e = new EditEngine(px(0));
    for (let i = 1; i <= 30; i++) e.push(px(i));
    let steps = 0;
    while (e.undo()) steps++;
    expect(steps).toBeLessThanOrEqual(20);
  });
});

describe('runOpSync', () => {
  it('dispatches adjust by kind', () => {
    const out = runOpSync({
      kind: 'adjust',
      buffer: px(100),
      params: { brightness: 50, contrast: 0, saturation: 0 },
    });
    expect(out.data[0]).toBeGreaterThan(100);
  });
});
```

- [ ] **Step 3: Verify failure**, then implement.

`edit-engine.ts`:

```ts
import { PixelBuffer, clonePixels } from './pixel-buffer';

const MAX_HISTORY = 20;

/** Snapshot-based undo/redo over the working image. */
export class EditEngine {
  private past: PixelBuffer[] = [];
  private future: PixelBuffer[] = [];
  private present: PixelBuffer;

  constructor(initial: PixelBuffer) {
    this.present = clonePixels(initial);
  }

  get current(): PixelBuffer {
    return this.present;
  }
  get canUndo(): boolean {
    return this.past.length > 0;
  }
  get canRedo(): boolean {
    return this.future.length > 0;
  }

  push(next: PixelBuffer): void {
    this.past.push(this.present);
    if (this.past.length > MAX_HISTORY) this.past.shift();
    this.present = next;
    this.future = [];
  }

  undo(): PixelBuffer | null {
    const prev = this.past.pop();
    if (!prev) return null;
    this.future.push(this.present);
    this.present = prev;
    return this.present;
  }

  redo(): PixelBuffer | null {
    const next = this.future.pop();
    if (!next) return null;
    this.past.push(this.present);
    this.present = next;
    return this.present;
  }

  reset(initial: PixelBuffer): void {
    this.past = [];
    this.future = [];
    this.present = clonePixels(initial);
  }
}
```

`ops/heal.ts`:

```ts
import { PixelBuffer } from '../pixel-buffer';

type CvModule = typeof import('@techstark/opencv-js');
let cvPromise: Promise<CvModule> | null = null;

/** OpenCV.js is ~8MB of WASM — load it once, only when heal is first used. */
function loadCv(): Promise<CvModule> {
  cvPromise ??= import('@techstark/opencv-js').then(
    (cv) => new Promise<CvModule>((resolve) => {
      const mod = (cv as unknown as { default?: CvModule }).default ?? cv;
      // opencv-js signals readiness via onRuntimeInitialized when WASM boots
      const anyMod = mod as unknown as { onRuntimeInitialized?: () => void; Mat?: unknown };
      if (anyMod.Mat) resolve(mod);
      else anyMod.onRuntimeInitialized = () => resolve(mod);
    }),
  );
  return cvPromise;
}

/**
 * Classical content-aware spot heal (Telea inpaint): repaints masked pixels
 * from their surroundings. mask = 1 byte/pixel, 255 where healing applies.
 */
export async function heal(buf: PixelBuffer, mask: Uint8Array): Promise<PixelBuffer> {
  const cv = await loadCv();
  const src = cv.matFromImageData({
    data: buf.data, width: buf.width, height: buf.height,
  } as ImageData);
  const rgb = new cv.Mat();
  cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
  const maskMat = cv.matFromArray(buf.height, buf.width, cv.CV_8UC1, Array.from(mask));
  const dst = new cv.Mat();
  cv.inpaint(rgb, maskMat, dst, 4, cv.INPAINT_TELEA);
  const rgba = new cv.Mat();
  cv.cvtColor(dst, rgba, cv.COLOR_RGB2RGBA);
  const out: PixelBuffer = {
    width: buf.width,
    height: buf.height,
    data: new Uint8ClampedArray(rgba.data),
  };
  src.delete(); rgb.delete(); maskMat.delete(); dst.delete(); rgba.delete();
  return out;
}
```

`edit-worker.ts` (doubles as the worker script and the sync fallback):

```ts
/// <reference lib="webworker" />
import { PixelBuffer } from './pixel-buffer';
import { AdjustParams, adjust } from './ops/adjust';
import { sharpen, smooth } from './ops/convolve';
import { CropRect, crop, rotate90 } from './ops/crop';
import { LiquifyStep, liquify } from './ops/liquify';

export type WorkerOp =
  | { kind: 'adjust'; buffer: PixelBuffer; params: AdjustParams }
  | { kind: 'sharpen'; buffer: PixelBuffer; params: number }
  | { kind: 'smooth'; buffer: PixelBuffer; params: number }
  | { kind: 'crop'; buffer: PixelBuffer; params: CropRect }
  | { kind: 'rotate90'; buffer: PixelBuffer; params: null }
  | { kind: 'liquify'; buffer: PixelBuffer; params: LiquifyStep };

/** Shared dispatch — the worker calls it; tests and no-Worker envs call it directly. */
export function runOpSync(op: WorkerOp): PixelBuffer {
  switch (op.kind) {
    case 'adjust': return adjust(op.buffer, op.params);
    case 'sharpen': return sharpen(op.buffer, op.params);
    case 'smooth': return smooth(op.buffer, op.params);
    case 'crop': return crop(op.buffer, op.params);
    case 'rotate90': return rotate90(op.buffer);
    case 'liquify': return liquify(op.buffer, op.params);
  }
}

// Worker entrypoint (ignored when imported as a module for runOpSync)
if (typeof self !== 'undefined' && typeof (self as unknown as Worker).postMessage === 'function'
  && typeof window === 'undefined') {
  self.onmessage = (e: MessageEvent<WorkerOp>) => {
    const result = runOpSync(e.data);
    (self as unknown as Worker).postMessage(result, [result.data.buffer]);
  };
}
```

- [ ] **Step 4: Run tests** — `npx vitest run src/app/core/editing` → PASS. Then full `npx vitest run` → all green.

- [ ] **Step 5: Report task done.**

---

### Task 4: EditSession service (Angular glue)

**Files:**
- Create: `src/app/core/editing/edit-session.ts`
- Test: `src/app/core/editing/edit-session.spec.ts`

**Interfaces:**
- Consumes: `EditEngine`, `runOpSync`/`WorkerOp`, `heal`, `GenerationDto`.
- Produces (signal service, `providedIn: 'root'`):
  - `open(item: GenerationDto): Promise<void>` — fetches `item.mediaUrl` into a PixelBuffer (browser decode via `createImageBitmap` + OffscreenCanvas)
  - `close(): void`
  - `item: Signal<GenerationDto | null>`, `dirty: Signal<boolean>`, `busy: Signal<boolean>`
  - `previewUrl: Signal<string>` — object URL of the current buffer, regenerated after every op (feeds `<img>` + MaskCanvas unchanged)
  - `canUndo/canRedo: Signal<boolean>`; `undo()/redo()`
  - `apply(op: WorkerOp['kind'], params: unknown): Promise<void>` — runs in Worker when available, sync otherwise; pushes history; marks dirty
  - `applyHeal(mask: Uint8Array): Promise<void>`
  - `exportPngBlob(): Promise<Blob>`
- Consumed by: canvas-viewport + studio-panel (Task 6/7).

- [ ] **Step 1: Write failing tests** (sync-path logic only — no DOM decode in vitest; inject buffers directly through a test seam `openWithBuffer(item, buf)`):

```ts
import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { EditSession } from './edit-session';
import { PixelBuffer } from './pixel-buffer';
import type { GenerationDto } from '../api/dtos';

function px(v: number): PixelBuffer {
  return { width: 2, height: 2, data: new Uint8ClampedArray(16).fill(v) };
}
const item = { id: 'g1', mediaUrl: 'blob:x' } as GenerationDto;

describe('EditSession', () => {
  function make(): EditSession {
    return TestBed.inject(EditSession);
  }
  it('opens with a buffer, starts clean', () => {
    const s = make();
    s.openWithBuffer(item, px(10));
    expect(s.item()?.id).toBe('g1');
    expect(s.dirty()).toBe(false);
  });
  it('apply marks dirty and enables undo', async () => {
    const s = make();
    s.openWithBuffer(item, px(10));
    await s.apply('adjust', { brightness: 50, contrast: 0, saturation: 0 });
    expect(s.dirty()).toBe(true);
    expect(s.canUndo()).toBe(true);
    s.undo();
    expect(s.canUndo()).toBe(false);
  });
  it('close resets state', async () => {
    const s = make();
    s.openWithBuffer(item, px(10));
    await s.apply('sharpen', 40);
    s.close();
    expect(s.item()).toBeNull();
    expect(s.dirty()).toBe(false);
  });
});
```

- [ ] **Step 2: Verify failure, implement** `edit-session.ts`:

```ts
import { Injectable, computed, signal } from '@angular/core';
import { GenerationDto } from '../api/dtos';
import { EditEngine } from './edit-engine';
import { PixelBuffer } from './pixel-buffer';
import { WorkerOp, runOpSync } from './edit-worker';
import { heal } from './ops/heal';

/**
 * One editing session over a library image: working pixels, history, dirty
 * state. Heavy ops go to a Worker when the platform has one; vitest and
 * fallback paths run synchronously — identical output either way.
 */
@Injectable({ providedIn: 'root' })
export class EditSession {
  private engine: EditEngine | null = null;
  private worker: Worker | null = null;
  private objectUrl = '';

  private readonly itemSig = signal<GenerationDto | null>(null);
  private readonly dirtySig = signal(false);
  private readonly busySig = signal(false);
  private readonly previewSig = signal('');
  private readonly historyTick = signal(0);

  readonly item = this.itemSig.asReadonly();
  readonly dirty = this.dirtySig.asReadonly();
  readonly busy = this.busySig.asReadonly();
  readonly previewUrl = this.previewSig.asReadonly();
  readonly canUndo = computed(() => {
    this.historyTick();
    return this.engine?.canUndo ?? false;
  });
  readonly canRedo = computed(() => {
    this.historyTick();
    return this.engine?.canRedo ?? false;
  });

  /** Browser entry: decode the media into pixels, then start the session. */
  async open(item: GenerationDto): Promise<void> {
    this.busySig.set(true);
    try {
      const res = await fetch(item.mediaUrl);
      const bitmap = await createImageBitmap(await res.blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      const img = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      this.openWithBuffer(item, { width: img.width, height: img.height, data: img.data });
    } finally {
      this.busySig.set(false);
    }
  }

  /** Test seam + shared init. */
  openWithBuffer(item: GenerationDto, buf: PixelBuffer): void {
    this.engine = new EditEngine(buf);
    this.itemSig.set(item);
    this.dirtySig.set(false);
    this.historyTick.update((n) => n + 1);
    this.refreshPreview();
  }

  close(): void {
    this.engine = null;
    this.itemSig.set(null);
    this.dirtySig.set(false);
    this.revokePreview();
    this.worker?.terminate();
    this.worker = null;
  }

  async apply(kind: WorkerOp['kind'], params: unknown): Promise<void> {
    if (!this.engine) return;
    this.busySig.set(true);
    try {
      const op = { kind, buffer: this.engine.current, params } as WorkerOp;
      const next = await this.run(op);
      this.engine.push(next);
      this.afterChange();
    } finally {
      this.busySig.set(false);
    }
  }

  async applyHeal(mask: Uint8Array): Promise<void> {
    if (!this.engine) return;
    this.busySig.set(true);
    try {
      const next = await heal(this.engine.current, mask);
      this.engine.push(next);
      this.afterChange();
    } finally {
      this.busySig.set(false);
    }
  }

  undo(): void {
    if (this.engine?.undo()) this.afterChange(this.engine.canUndo);
  }
  redo(): void {
    if (this.engine?.redo()) this.afterChange();
  }

  current(): PixelBuffer | null {
    return this.engine?.current ?? null;
  }

  async exportPngBlob(): Promise<Blob> {
    const buf = this.engine!.current;
    const canvas = new OffscreenCanvas(buf.width, buf.height);
    const ctx = canvas.getContext('2d')!;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(buf.data), buf.width, buf.height), 0, 0);
    return canvas.convertToBlob({ type: 'image/png' });
  }

  private run(op: WorkerOp): Promise<PixelBuffer> {
    if (typeof Worker === 'undefined') return Promise.resolve(runOpSync(op));
    this.worker ??= new Worker(new URL('./edit-worker', import.meta.url), { type: 'module' });
    return new Promise((resolve, reject) => {
      const w = this.worker!;
      const onMessage = (e: MessageEvent<PixelBuffer>) => {
        w.removeEventListener('message', onMessage);
        resolve(e.data);
      };
      const onError = (e: ErrorEvent) => {
        w.removeEventListener('error', onError);
        // Worker broke — fall back to the main thread, same math.
        try { resolve(runOpSync(op)); } catch (err) { reject(err ?? e); }
      };
      w.addEventListener('message', onMessage);
      w.addEventListener('error', onError);
      w.postMessage(op);
    });
  }

  private afterChange(dirty = true): void {
    this.dirtySig.set(dirty);
    this.historyTick.update((n) => n + 1);
    this.refreshPreview();
  }

  private refreshPreview(): void {
    if (typeof OffscreenCanvas === 'undefined') return; // vitest
    void this.exportPngBlob().then((blob) => {
      this.revokePreview();
      this.objectUrl = URL.createObjectURL(blob);
      this.previewSig.set(this.objectUrl);
    });
  }

  private revokePreview(): void {
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = '';
    this.previewSig.set('');
  }
}
```

- [ ] **Step 3: Run tests** — `npx vitest run` → PASS.
- [ ] **Step 4: Report task done.**

---

### Task 5: Backend — /edits/save, edit-tool generations, fal fill/birefnet, migration, deploy

**Files:**
- Modify: `supabase/functions/api/index.ts`
- Modify: `supabase/functions/_shared/providers/fal.ts` (mirror into `src/`? No — fal.ts is backend-only, lives only under `_shared/`)
- Create: `supabase/migrations/0005_studio_editing.sql`
- Modify: `supabase/functions/_shared/model-families.ts` (already regenerated by Task 1's sync-shared)
- Test: extend `/private/tmp/.../scratchpad/e2e-happy.mjs`-style checks via a new scratchpad script (below)

**Interfaces:**
- Consumes: `EDIT_TOOLS`, `editToolById` from `./_shared/model-families.ts` (post-sync).
- Produces:
  - `POST /edits/save` — multipart `file` (PNG) + `parentId`; 403 `studio_required` without active Studio; 422 `content_policy` + strike on flagged image; 200 `{ item: GenerationDto, ... }`.
  - `POST /generations` accepts `familyId` ∈ EDIT_TOOLS ids with `op: 'edit'`; fixed price; mask required for `edit-remove`/`edit-fill`.

- [ ] **Step 1: fal adapter — new slugs + payloads.** In `_shared/providers/fal.ts` replace `slugFor` and `payloadFor`:

```ts
/** familyId (+ op/reference) → fal model slug. */
function slugFor(ctx: SubmitCtx): string {
  if (ctx.familyId === 'upscaler' || ctx.op === 'upscale') return 'fal-ai/clarity-upscaler';
  if (ctx.familyId === 'edit-bg') return 'fal-ai/birefnet/v2';
  if (ctx.familyId === 'edit-remove' || ctx.familyId === 'edit-fill' || ctx.familyId === 'edit-expand') {
    return 'fal-ai/flux-pro/v1/fill';
  }
  if (ctx.familyId === 'flux') return 'fal-ai/flux-pro/v1.1';
  if (ctx.familyId === 'seedream') {
    return ctx.referenceUrl
      ? 'fal-ai/bytedance/seedream/v4/edit'
      : 'fal-ai/bytedance/seedream/v4/text-to-image';
  }
  throw new Error(`fal: no slug for ${ctx.familyId}`);
}

function payloadFor(ctx: SubmitCtx): Record<string, unknown> {
  const aspect = String(ctx.settings['aspectRatio'] ?? '1:1');
  if (ctx.familyId === 'upscaler' || ctx.op === 'upscale') {
    return { image_url: ctx.referenceUrl };
  }
  if (ctx.familyId === 'edit-bg') {
    return { image_url: ctx.referenceUrl };
  }
  if (ctx.familyId === 'edit-remove' || ctx.familyId === 'edit-fill' || ctx.familyId === 'edit-expand') {
    // FLUX fill: repaint where the mask is white. Mask arrives as a data URI —
    // fal accepts data: URLs for image inputs. Expand sends a pre-padded image
    // + border mask the client built; remove uses a fixed background prompt.
    return {
      image_url: ctx.referenceUrl,
      mask_url: ctx.maskPngBase64,
      prompt: ctx.prompt,
    };
  }
  const body: Record<string, unknown> = { prompt: ctx.prompt, aspect_ratio: aspect };
  if (ctx.referenceUrl) {
    if (ctx.familyId === 'seedream') body.image_urls = [ctx.referenceUrl];
    else body.image_url = ctx.referenceUrl;
  }
  return body;
}
```

Note: verify exact slugs against fal docs at implementation time (`fal-ai/flux-pro/v1/fill`, `fal-ai/birefnet/v2`); if a slug 404s on submit, check fal's model page and adjust — the structure stays.

- [ ] **Step 2: Gateway — imports + price resolution.** In `api/index.ts`:

Add `editToolById` to the `_shared/model-families.ts` import list. In `POST /generations`, replace the family-resolution `else` branch with:

```ts
  } else {
    const editTool = editToolById(String(body.familyId ?? ''));
    if (editTool) {
      // Studio panel AI tool — fixed retail price, edit op only, Studio members only.
      if (op !== GenerationOp.Edit) return fail(c, 400, 'invalid_op', 'Edit tools use op=edit');
      if (!(await hasActiveStudio(userId))) {
        return fail(c, 403, 'studio_required', 'Studio subscription required for editing tools.');
      }
      if (editTool.needsMask && typeof body.maskPngBase64 !== 'string') {
        return fail(c, 400, 'invalid_payload', `${editTool.name} requires a mask`);
      }
      familyId = editTool.id;
      familyName = editTool.name;
      kind = MediaKind.Image;
      unitPrice = editTool.userPriceUsd; // fixed retail — no rounding drift
    } else {
      const family = familyById(String(body.familyId ?? ''));
      if (!family) return fail(c, 400, 'invalid_family', 'Unknown model family');
      if (family.kind === MediaKind.Video && op !== GenerationOp.Generate && op !== GenerationOp.Variation) {
        return fail(c, 400, 'invalid_op', 'Video supports generate/variation only');
      }
      familyId = family.id;
      familyName = family.name;
      kind = family.kind;
      unitPrice = round2(userPriceUsd(family, settings));
    }
  }
```

Prompt rule: `edit-remove`, `edit-expand`, `edit-bg` need no user prompt — the client sends fixed server-friendly prompts (Task 7): remove = `"remove the masked object and seamlessly continue the background"`, expand = `"continue the image naturally beyond its original edges"`, bg = `"remove background"`. These pass the existing `!prompt` check unchanged; moderation still runs (cheap, harmless).

- [ ] **Step 3: Gateway — `POST /edits/save`.** Add after the `/uploads` handler:

```ts
/** Persist a locally-edited canvas as a new $0 generation version. */
app.post('/edits/save', async (c) => {
  const userId = c.get('userId');
  if (await isSuspended(userId)) {
    return fail(c, 429, 'account_suspended', 'Account suspended — contact support to appeal.');
  }
  if (!(await hasActiveStudio(userId))) {
    return fail(c, 403, 'studio_required', 'Studio subscription required for editing tools.');
  }
  const form = await c.req.formData().catch(() => null);
  const file = form?.get('file');
  const parentId = String(form?.get('parentId') ?? '');
  if (!(file instanceof File)) return fail(c, 400, 'upload_failed', 'No file provided');
  if (file.size > UPLOAD_MAX_BYTES) return fail(c, 400, 'upload_failed', 'File exceeds 10MB');
  if (!parentId) return fail(c, 400, 'invalid_parent', 'parentId required');

  const { data: parent } = await admin
    .from('generations')
    .select('id,prompt,settings')
    .eq('id', parentId)
    .eq('user_id', userId)
    .maybeSingle();
  if (!parent) return fail(c, 404, 'not_found', 'Parent generation not found');

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (sniffImage(bytes) !== 'png') return fail(c, 400, 'upload_failed', 'PNG required');

  // Moderation BEFORE anything persists outside quarantine reach.
  const scratch = `scratch/${userId}/${crypto.randomUUID()}.png`;
  await admin.storage.from('uploads').upload(scratch, bytes, { contentType: 'image/png' });
  const { data: signed } = await admin.storage.from('uploads').createSignedUrl(scratch, 600);
  const mod = await moderate({ imageUrl: signed?.signedUrl });
  if (mod.flagged) {
    const quarantine = `quarantine/${userId}/${crypto.randomUUID()}.png`;
    await admin.storage.from('uploads').copy(scratch, quarantine);
    await admin.storage.from('uploads').remove([scratch]);
    await recordStrike(userId, 'upload', null, mod.categories, quarantine);
    return fail(c, 422, 'content_policy', 'This image violates our content policy.');
  }
  await admin.storage.from('uploads').remove([scratch]);

  const { data: gen, error } = await admin
    .from('generations')
    .insert({
      user_id: userId,
      kind: MediaKind.Image,
      family_id: 'studio',
      family_name: 'Studio Edit',
      op: GenerationOp.Edit,
      prompt: parent.prompt,
      settings: parent.settings,
      price_usd: 0,
      status: 'done',
      media_url: '',
      parent_id: parentId,
    })
    .select('*')
    .single();
  if (error || !gen) return fail(c, 400, 'save_failed', 'Could not save the edit');

  const path = `${userId}/${gen['id']}.png`;
  const { error: upErr } = await admin.storage.from('media').upload(path, bytes, {
    contentType: 'image/png',
    upsert: true,
  });
  if (upErr) {
    await admin.from('generations').delete().eq('id', gen['id']);
    return fail(c, 400, 'save_failed', 'Storage rejected the file');
  }
  await admin.from('generations').update({ media_path: path }).eq('id', gen['id']);
  return c.json({ item: await toGenerationDto({ ...gen, media_path: path }) });
});
```

- [ ] **Step 4: Migration.** Create `supabase/migrations/0005_studio_editing.sql` AND apply via MCP `execute_sql`:

```sql
-- Phase 3b Studio editing panel: kill-switch rows for the four AI edit tools.
insert into public.models (id, enabled) values
  ('edit-remove', true), ('edit-fill', true), ('edit-expand', true), ('edit-bg', true)
on conflict (id) do nothing;
```

- [ ] **Step 5: Client DTO.** Add to `src/app/core/api/dtos.ts`:

```ts
export interface SaveEditResponse {
  item: GenerationDto;
}
```

- [ ] **Step 6: Deploy + verify.** `npm run sync-shared`, `npx vitest run` (drift guard), then MCP `deploy_edge_function` for `api` bundling `index.ts` + every `_shared/` file. Write scratchpad script `e2e-edits.mjs` (auth as an existing funded test user; POST /edits/save with a tiny PNG + a real parentId → expect 200 + price 0 row, or 403 studio_required for a non-Studio user; POST /generations familyId=edit-bg op=edit parentId=<saved id> → poll GET /jobs → done+mediaUrl; verify kill switch by flipping `edit-bg` off via SQL → 503 → flip back). Run it; all steps must print expected results.

- [ ] **Step 7: Report task done.**

---

### Task 6: Workspace edit mode + canvas viewport (absorb /app/edit)

**Files:**
- Create: `src/app/features/studio/canvas-viewport/canvas-viewport.ts` + `.html` + `.css`
- Modify: `src/app/features/workspace/workspace-page.ts` / `.html` / `.css`
- Modify: `src/app/app.routes.ts`
- Delete: `src/app/features/editor/` (editor-page + its html/css; MaskCanvas MOVES to `src/app/features/studio/mask-canvas/` unchanged)

**Interfaces:**
- Consumes: `EditSession` (Task 4), `MaskCanvas` (moved).
- Produces: `CanvasViewport` component — inputs none (reads EditSession), exposes `maskCanvas = viewChild(MaskCanvas)` so the workspace can pull `exportMaskPng()`/`clear()`; workspace `mode: Signal<'library' | 'edit'>`, `enterEdit(id: string)`, `exitEdit()`.

- [ ] **Step 1: canvas-viewport.** `canvas-viewport.ts`:

```ts
import { ChangeDetectionStrategy, Component, inject, signal, viewChild } from '@angular/core';
import { EditSession } from '../../../core/editing/edit-session';
import { MaskCanvas } from '../mask-canvas/mask-canvas';

/** Center stage in edit mode: the working image + paintable mask overlay. */
@Component({
  selector: 'app-canvas-viewport',
  templateUrl: './canvas-viewport.html',
  styleUrl: './canvas-viewport.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MaskCanvas],
})
export class CanvasViewport {
  readonly session = inject(EditSession);
  readonly maskCanvas = viewChild(MaskCanvas);
  /** Mask painting active (mask tool or a mask-needing AI tool selected). */
  readonly maskEnabled = signal(false);
}
```

`canvas-viewport.html`:

```html
<div class="viewport">
  @if (session.previewUrl(); as url) {
    <app-mask-canvas [imageUrl]="url" [enabled]="maskEnabled()" />
  }
  @if (session.busy()) {
    <div class="busy-veil">Working…</div>
  }
</div>
```

`canvas-viewport.css`:

```css
.viewport {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  min-height: 0;
  background: var(--color-muted, #111);
  border-radius: 12px;
  overflow: hidden;
}
.viewport app-mask-canvas { max-width: 100%; max-height: 100%; }
.busy-veil {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background: rgb(0 0 0 / 0.45);
  color: #fff;
  font-size: 0.9rem;
}
```

- [ ] **Step 2: Move MaskCanvas** — `git mv src/app/features/editor/mask-canvas src/app/features/studio/mask-canvas` (mv only, no commit), update its import path everywhere it is referenced.

- [ ] **Step 3: Workspace wiring.** `workspace-page.ts` additions:

```ts
readonly editSession = inject(EditSession);
readonly viewport = viewChild(CanvasViewport);

/** 'library' shows the grid; 'edit' swaps in the canvas viewport. */
readonly mode = signal<'library' | 'edit'>('library');

async enterEdit(id: string): Promise<void> {
  const item = this.store.byId(id);
  if (!item || item.kind !== 'image' || item.status !== 'done') return;
  await this.editSession.open(item);
  this.mode.set('edit');
}

exitEdit(): void {
  if (this.editSession.dirty() && !confirm('Discard unsaved edits?')) return;
  this.editSession.close();
  this.mode.set('library');
}
```

`onEdit(id)` becomes `void this.enterEdit(id)` (no router navigation). Constructor addition — deep link support for the absorbed route:

```ts
const editParam = this.route.snapshot.paramMap.get('id');
if (editParam) {
  void this.refresh().then(() => this.enterEdit(editParam));
}
```

(guard so `refresh()` isn't called twice — restructure the existing constructor call accordingly).

`workspace-page.html`: wrap the `<app-library-grid>` block:

```html
@if (mode() === 'edit') {
  <app-canvas-viewport />
} @else {
  <app-library-grid ... existing bindings ... />
}
```

Breadcrumb: `<span class="crumb-current">{{ mode() === 'edit' ? 'Edit' : 'Library' }}</span>` plus a back button in edit mode:

```html
@if (mode() === 'edit') {
  <button type="button" class="linkish" (click)="exitEdit()">‹ Library</button>
}
```

- [ ] **Step 4: Routes.** In `app.routes.ts` replace the editor route:

```ts
{
  path: 'app/edit/:id',
  canActivate: [authGuard],
  loadComponent: () => import('./features/workspace/workspace-page').then((m) => m.WorkspacePage),
},
```

Delete `src/app/features/editor/editor-page.ts|.html|.css`. Anything still importing them (search `features/editor`) moves to the new paths.

- [ ] **Step 5: Build + test** — `npx ng build` clean, `npx vitest run` green. Manually: open workspace, click Edit on an image → canvas mode with image visible, back returns to grid.

- [ ] **Step 6: Report task done.**

---

### Task 7: Studio panel + tool options + AI tool flow

**Files:**
- Create: `src/app/features/studio/studio-panel/studio-panel.ts` + `.html` + `.css`
- Create: `src/app/features/studio/tool-options/tool-options.ts` + `.html` + `.css`
- Modify: `src/app/features/workspace/workspace-page.ts` / `.html` / `.css` (mount panel, wire AI flow)
- Modify: `src/app/core/generations/generation-store.ts` (add `saveEdit`)

**Interfaces:**
- Consumes: `EditSession`, `EDIT_TOOLS`, `editToolById`, `LedgerService.balanceUsd`, `ProfileStore.studioActive`, `ApiService.postForm`, `SaveEditResponse`.
- Produces:
  - `StudioPanel` outputs: `saveRequested`, `aiToolRequested: output<{ toolId: string; prompt: string }>`; input `editing: input<boolean>`
  - `GenerationStore.saveEdit(blob: Blob, parentId: string): Promise<GenerationDto>`
  - Local tool state type: `type StudioTool = 'crop' | 'adjust' | 'sharpen' | 'smooth' | 'liquify' | 'heal' | 'mask'`

- [ ] **Step 1: store method.** `generation-store.ts`:

```ts
/** Persist a locally-edited canvas as a $0 version row. */
async saveEdit(blob: Blob, parentId: string): Promise<GenerationDto> {
  const form = new FormData();
  form.append('file', blob, 'edit.png');
  form.append('parentId', parentId);
  const res = await this.api.postForm<SaveEditResponse>('/edits/save', form);
  this.itemsSig.update((list) => [res.item, ...list]);
  return res.item;
}
```

- [ ] **Step 2: studio-panel.** `studio-panel.ts`:

```ts
import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideBrush, lucideCrop, lucideEraser, lucideLock, lucideRedo2, lucideScan,
  lucideSlidersHorizontal, lucideSparkles, lucideUndo2, lucideWand,
} from '@ng-icons/lucide';
import { HlmButton } from '@spartan-ng/helm/button';
import { EDIT_TOOLS } from '../../../core/catalog/model-families';
import { EditSession } from '../../../core/editing/edit-session';
import { LedgerService } from '../../../core/ledger/ledger-service';
import { ProfileStore } from '../../../core/profile/profile-store';

export type StudioTool = 'crop' | 'adjust' | 'sharpen' | 'smooth' | 'liquify' | 'heal' | 'mask';

interface LocalToolDef { id: StudioTool; label: string; icon: string }

const LOCAL_TOOLS: LocalToolDef[] = [
  { id: 'crop', label: 'Crop', icon: 'lucideCrop' },
  { id: 'adjust', label: 'Adjust', icon: 'lucideSlidersHorizontal' },
  { id: 'sharpen', label: 'Sharpen', icon: 'lucideWand' },
  { id: 'smooth', label: 'Smooth', icon: 'lucideWand' },
  { id: 'liquify', label: 'Liquify', icon: 'lucideScan' },
  { id: 'heal', label: 'Spot Heal', icon: 'lucideBrush' },
  { id: 'mask', label: 'Mask', icon: 'lucideEraser' },
];

/** Right rail: free local tools on top, priced AI tools below, Studio-gated. */
@Component({
  selector: 'app-studio-panel',
  templateUrl: './studio-panel.html',
  styleUrl: './studio-panel.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe, NgIcon, HlmButton],
  providers: [
    provideIcons({
      lucideBrush, lucideCrop, lucideEraser, lucideLock, lucideRedo2, lucideScan,
      lucideSlidersHorizontal, lucideSparkles, lucideUndo2, lucideWand,
    }),
  ],
})
export class StudioPanel {
  readonly session = inject(EditSession);
  private readonly ledger = inject(LedgerService);
  private readonly profileStore = inject(ProfileStore);

  /** True while the workspace is in edit mode (panel is a teaser otherwise). */
  readonly editing = input(false);

  readonly saveRequested = output<void>();
  readonly aiToolRequested = output<{ toolId: string; prompt: string }>();

  readonly localTools = LOCAL_TOOLS;
  readonly aiTools = EDIT_TOOLS;
  readonly studioActive = this.profileStore.studioActive;
  readonly balanceUsd = this.ledger.balanceUsd;

  /** Studio | Pro tier switch — Pro is a locked teaser in this phase. */
  readonly tier = signal<'studio' | 'pro'>('studio');
  readonly activeTool = signal<StudioTool | null>(null);
  /** Prompt for Generative Fill. */
  readonly fillPrompt = signal('');

  readonly locked = computed(() => !this.studioActive());

  selectTool(id: StudioTool): void {
    this.activeTool.set(this.activeTool() === id ? null : id);
  }

  affordable(priceUsd: number): boolean {
    return this.balanceUsd() >= priceUsd;
  }

  runAiTool(toolId: string): void {
    const tool = this.aiTools.find((t) => t.id === toolId);
    if (!tool || !this.affordable(tool.userPriceUsd)) return;
    if (tool.needsPrompt && !this.fillPrompt().trim()) return;
    this.aiToolRequested.emit({ toolId, prompt: this.fillPrompt().trim() });
  }
}
```

`studio-panel.html`:

```html
<aside class="studio-rail" [class.rail-locked]="locked()">
  <div class="tier-switch">
    <button type="button" class="tier-btn" [class.tier-active]="tier() === 'studio'"
      (click)="tier.set('studio')">Studio</button>
    <button type="button" class="tier-btn tier-disabled" title="Pro — coming soon: video editing and more free tools">
      <ng-icon name="lucideLock" size="12" /> Pro
    </button>
  </div>

  @if (locked()) {
    <div class="lock-card">
      <ng-icon name="lucideLock" size="20" />
      <p>Editing tools are a Studio perk.</p>
      <button hlmBtn size="sm" type="button" (click)="saveRequested.emit()">
        Subscribe to Studio · $5/mo
      </button>
    </div>
  } @else if (!editing()) {
    <p class="teaser-hint">Open an image to start editing.</p>
  } @else {
    <section class="tool-section">
      <h3 class="section-title">Tools</h3>
      <div class="tool-grid">
        @for (tool of localTools; track tool.id) {
          <button type="button" class="tool-btn" [class.tool-active]="activeTool() === tool.id"
            (click)="selectTool(tool.id)">
            <ng-icon [name]="tool.icon" size="15" />
            <span>{{ tool.label }}</span>
          </button>
        }
      </div>
    </section>

    <section class="tool-section ai-section">
      <h3 class="section-title">AI Tools <span class="ai-note">· uses balance</span></h3>
      @for (tool of aiTools; track tool.id) {
        <div class="ai-tool">
          <button type="button" class="ai-run" [disabled]="!affordable(tool.userPriceUsd)"
            [title]="tool.blurb" (click)="runAiTool(tool.id)">
            <ng-icon name="lucideSparkles" size="14" />
            <span>{{ tool.name }}</span>
            <span class="price-chip">${{ tool.userPriceUsd | number: '1.2-2' }}</span>
          </button>
          @if (tool.needsPrompt) {
            <input class="fill-prompt" type="text" placeholder="What should appear here?"
              [value]="fillPrompt()" (input)="fillPrompt.set($any($event.target).value)" />
          }
        </div>
      }
      @if (balanceUsd() < 0.05) {
        <p class="ai-note">Balance too low — top up to use AI tools.</p>
      }
    </section>

    <div class="rail-actions">
      <button hlmBtn variant="ghost" size="sm" type="button" [disabled]="!session.canUndo()"
        (click)="session.undo()"><ng-icon name="lucideUndo2" size="14" /></button>
      <button hlmBtn variant="ghost" size="sm" type="button" [disabled]="!session.canRedo()"
        (click)="session.redo()"><ng-icon name="lucideRedo2" size="14" /></button>
      <button hlmBtn size="sm" type="button" [disabled]="!session.dirty()"
        (click)="saveRequested.emit()">Save as new version</button>
    </div>
  }
</aside>
```

`studio-panel.css` (tight, theme-following):

```css
.studio-rail {
  display: flex;
  flex-direction: column;
  gap: 14px;
  width: 240px;
  padding: 14px;
  border-left: 1px solid var(--color-border, #26262a);
  overflow-y: auto;
}
.tier-switch { display: flex; gap: 6px; }
.tier-btn {
  flex: 1;
  padding: 6px 0;
  border-radius: 8px;
  border: 1px solid var(--color-border, #26262a);
  background: transparent;
  color: inherit;
  font-size: 0.8rem;
  cursor: pointer;
}
.tier-active { background: var(--color-accent, #825aff); color: #fff; border-color: transparent; }
.tier-disabled { opacity: 0.55; cursor: not-allowed; }
.section-title { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em; opacity: 0.7; margin: 0 0 8px; }
.ai-note { font-size: 0.72rem; opacity: 0.6; text-transform: none; }
.tool-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.tool-btn, .ai-run {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 7px 9px;
  border-radius: 8px;
  border: 1px solid var(--color-border, #26262a);
  background: transparent;
  color: inherit;
  font-size: 0.78rem;
  cursor: pointer;
}
.tool-active { border-color: var(--color-accent, #825aff); }
.ai-section { border-top: 1px solid var(--color-border, #26262a); padding-top: 12px; }
.ai-tool { margin-bottom: 8px; }
.ai-run:disabled { opacity: 0.45; cursor: not-allowed; }
.price-chip {
  margin-left: auto;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--color-accent, #825aff);
  color: #fff;
  font-size: 0.7rem;
}
.fill-prompt {
  width: 100%;
  margin-top: 5px;
  padding: 6px 8px;
  border-radius: 7px;
  border: 1px solid var(--color-border, #26262a);
  background: transparent;
  color: inherit;
  font-size: 0.78rem;
}
.rail-actions { display: flex; gap: 6px; margin-top: auto; }
.lock-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 22px 12px;
  border: 1px dashed var(--color-border, #26262a);
  border-radius: 10px;
  text-align: center;
  font-size: 0.82rem;
}
.teaser-hint { font-size: 0.8rem; opacity: 0.6; }
```

- [ ] **Step 3: tool-options.** Sliders/params for the active tool; emits engine calls through EditSession. `tool-options.ts`:

```ts
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { EditSession } from '../../../core/editing/edit-session';
import { StudioTool } from '../studio-panel/studio-panel';
import { input } from '@angular/core';

/** Parameter strip for the active local tool (brush size, amounts, apply). */
@Component({
  selector: 'app-tool-options',
  templateUrl: './tool-options.html',
  styleUrl: './tool-options.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ToolOptions {
  readonly session = inject(EditSession);
  readonly tool = input<StudioTool | null>(null);

  readonly brightness = signal(0);
  readonly contrast = signal(0);
  readonly saturation = signal(0);
  readonly amount = signal(50);
  readonly brushSize = signal(40);

  async applyAdjust(): Promise<void> {
    await this.session.apply('adjust', {
      brightness: this.brightness(), contrast: this.contrast(), saturation: this.saturation(),
    });
    this.brightness.set(0); this.contrast.set(0); this.saturation.set(0);
  }
  async applySharpen(): Promise<void> {
    await this.session.apply('sharpen', this.amount());
  }
  async applySmooth(): Promise<void> {
    await this.session.apply('smooth', this.amount());
  }
  async applyRotate(): Promise<void> {
    await this.session.apply('rotate90', null);
  }
}
```

`tool-options.html`:

```html
@switch (tool()) {
  @case ('adjust') {
    <div class="opts">
      <label>Brightness <input type="range" min="-100" max="100" [value]="brightness()"
        (input)="brightness.set(+$any($event.target).value)" /></label>
      <label>Contrast <input type="range" min="-100" max="100" [value]="contrast()"
        (input)="contrast.set(+$any($event.target).value)" /></label>
      <label>Saturation <input type="range" min="-100" max="100" [value]="saturation()"
        (input)="saturation.set(+$any($event.target).value)" /></label>
      <button type="button" class="apply-btn" (click)="applyAdjust()">Apply</button>
    </div>
  }
  @case ('sharpen') {
    <div class="opts">
      <label>Amount <input type="range" min="0" max="100" [value]="amount()"
        (input)="amount.set(+$any($event.target).value)" /></label>
      <button type="button" class="apply-btn" (click)="applySharpen()">Apply sharpen</button>
    </div>
  }
  @case ('smooth') {
    <div class="opts">
      <label>Amount <input type="range" min="0" max="100" [value]="amount()"
        (input)="amount.set(+$any($event.target).value)" /></label>
      <button type="button" class="apply-btn" (click)="applySmooth()">Apply smooth</button>
    </div>
  }
  @case ('crop') {
    <div class="opts">
      <p class="opt-hint">Drag on the image to choose the crop area.</p>
      <button type="button" class="apply-btn" (click)="applyRotate()">Rotate 90°</button>
    </div>
  }
  @case ('liquify') {
    <div class="opts">
      <label>Brush <input type="range" min="10" max="200" [value]="brushSize()"
        (input)="brushSize.set(+$any($event.target).value)" /></label>
      <p class="opt-hint">Drag on the image to push pixels.</p>
    </div>
  }
  @case ('heal') {
    <div class="opts">
      <label>Brush <input type="range" min="10" max="120" [value]="brushSize()"
        (input)="brushSize.set(+$any($event.target).value)" /></label>
      <p class="opt-hint">Paint over a blemish, then release to heal.</p>
    </div>
  }
  @case ('mask') {
    <div class="opts">
      <p class="opt-hint">Paint where AI tools should work. Unmasked areas stay untouched.</p>
    </div>
  }
}
```

`tool-options.css`:

```css
.opts { display: flex; flex-direction: column; gap: 8px; font-size: 0.78rem; }
.opts label { display: flex; flex-direction: column; gap: 3px; }
.opt-hint { opacity: 0.6; margin: 0; }
.apply-btn {
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid var(--color-border, #26262a);
  background: var(--color-accent, #825aff);
  color: #fff;
  font-size: 0.78rem;
  cursor: pointer;
}
```

Mount `<app-tool-options [tool]="activeTool()" />` inside studio-panel.html under the tool grid; add `ToolOptions` to StudioPanel imports.

Canvas interactions live in canvas-viewport. Extend `CanvasViewport` with inputs `[tool]` (active StudioTool) and `[brushSize]`, and these handlers (bound on the `.viewport` element: `(pointerdown)`, `(pointermove)`, `(pointerup)`); MaskCanvas `[enabled]` becomes `tool() === 'mask'`:

```ts
readonly tool = input<StudioTool | null>(null);
readonly brushSize = input(40);

/** Crop drag rectangle in image pixels, null = none. */
readonly cropRect = signal<CropRect | null>(null);

private dragStart: { x: number; y: number } | null = null;
private healStroke: { x: number; y: number }[] = [];
private liquifyLast: { x: number; y: number } | null = null;

/** Screen point → image-pixel point using the preview img's displayed size. */
private toImagePoint(e: PointerEvent): { x: number; y: number } | null {
  const img = (e.currentTarget as HTMLElement).querySelector('img');
  const buf = this.session.current();
  if (!img || !buf) return null;
  const r = img.getBoundingClientRect();
  return {
    x: ((e.clientX - r.x) / r.width) * buf.width,
    y: ((e.clientY - r.y) / r.height) * buf.height,
  };
}

onPointerDown(e: PointerEvent): void {
  const p = this.toImagePoint(e);
  if (!p) return;
  const t = this.tool();
  if (t === 'crop') this.dragStart = p;
  if (t === 'heal') this.healStroke = [p];
  if (t === 'liquify') this.liquifyLast = p;
}

onPointerMove(e: PointerEvent): void {
  const p = this.toImagePoint(e);
  if (!p) return;
  const t = this.tool();
  if (t === 'crop' && this.dragStart) {
    this.cropRect.set({
      x: Math.min(this.dragStart.x, p.x),
      y: Math.min(this.dragStart.y, p.y),
      width: Math.abs(p.x - this.dragStart.x),
      height: Math.abs(p.y - this.dragStart.y),
    });
  }
  if (t === 'heal' && this.healStroke.length) this.healStroke.push(p);
  if (t === 'liquify' && this.liquifyLast && !this.session.busy()) {
    const step = {
      cx: this.liquifyLast.x, cy: this.liquifyLast.y,
      radius: this.brushSize(), dx: p.x - this.liquifyLast.x, dy: p.y - this.liquifyLast.y,
    };
    this.liquifyLast = p;
    void this.session.apply('liquify', step);
  }
}

async onPointerUp(): Promise<void> {
  const t = this.tool();
  if (t === 'heal' && this.healStroke.length) {
    const buf = this.session.current()!;
    const mask = new Uint8Array(buf.width * buf.height);
    for (const pt of this.healStroke) stampCircle(mask, buf.width, buf.height, pt, this.brushSize());
    this.healStroke = [];
    await this.session.applyHeal(mask);
  }
  this.dragStart = null;
  this.liquifyLast = null;
}

async applyCrop(): Promise<void> {
  const r = this.cropRect();
  if (!r || r.width < 4 || r.height < 4) return;
  await this.session.apply('crop', r);
  this.cropRect.set(null);
}
```

Helper at file bottom:

```ts
function stampCircle(
  mask: Uint8Array, w: number, h: number, p: { x: number; y: number }, radius: number,
): void {
  const r2 = radius * radius;
  const x0 = Math.max(0, Math.floor(p.x - radius));
  const x1 = Math.min(w - 1, Math.ceil(p.x + radius));
  const y0 = Math.max(0, Math.floor(p.y - radius));
  const y1 = Math.min(h - 1, Math.ceil(p.y + radius));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if ((x - p.x) ** 2 + (y - p.y) ** 2 <= r2) mask[y * w + x] = 255;
    }
  }
}
```

Template additions in `canvas-viewport.html` (crop overlay + apply button; `.crop-box` positions via percentage math from cropRect vs buffer dims — compute a `cropStyle` signal with `left/top/width/height` percentages and bind `[style.left.%]` etc.):

```html
<div class="viewport" (pointerdown)="onPointerDown($event)"
  (pointermove)="onPointerMove($event)" (pointerup)="onPointerUp()">
  @if (session.previewUrl(); as url) {
    <app-mask-canvas [imageUrl]="url" [enabled]="tool() === 'mask'" />
  }
  @if (cropRect(); as r) {
    <div class="crop-box" [style.left.%]="cropPct().left" [style.top.%]="cropPct().top"
      [style.width.%]="cropPct().width" [style.height.%]="cropPct().height"></div>
    <button type="button" class="crop-apply" (click)="applyCrop()">Apply crop</button>
  }
  @if (session.busy()) {
    <div class="busy-veil">Working…</div>
  }
</div>
```

with `cropPct = computed(() => { const r = this.cropRect(); const b = this.session.current(); if (!r || !b) return { left: 0, top: 0, width: 0, height: 0 }; return { left: (r.x / b.width) * 100, top: (r.y / b.height) * 100, width: (r.width / b.width) * 100, height: (r.height / b.height) * 100 }; })` and CSS `.crop-box { position: absolute; border: 1.5px dashed #fff; background: rgb(130 90 255 / 0.15); pointer-events: none; } .crop-apply { position: absolute; bottom: 12px; right: 12px; }`. Workspace passes `[tool]` and `[brushSize]` down from StudioPanel state (lift `activeTool`/`brushSize` read: workspace binds `<app-canvas-viewport [tool]="panel().activeTool()" [brushSize]="panel().brushSize()" />` with `panel = viewChild.required(StudioPanel)`; move `brushSize` signal from ToolOptions into StudioPanel so both panel and viewport read one source).

Mask tool reuses MaskCanvas (enabled when activeTool is `mask`); mask-needing AI tools read whatever mask the user painted there.

- [ ] **Step 4: Workspace AI flow.** In `workspace-page.ts`:

```ts
async onSaveEdit(): Promise<void> {
  const item = this.editSession.item();
  if (!item) return;
  try {
    const blob = await this.editSession.exportPngBlob();
    const saved = await this.store.saveEdit(blob, item.id);
    this.editSession.openWithBufferFromCurrent(saved); // keep editing the saved version
    this.notice.set('Saved as a new version.');
  } catch (e) {
    this.showError(e, 'Save failed');
  }
}

async onAiTool(req: { toolId: string; prompt: string }): Promise<void> {
  const item = this.editSession.item();
  if (!item) return;
  const tool = editToolById(req.toolId);
  if (!tool) return;
  const mask = this.viewport()?.maskCanvas()?.exportMaskPng() ?? undefined;
  if (tool.needsMask && !mask) {
    this.notice.set('Paint a mask first — the tool needs to know where to work.');
    return;
  }
  try {
    // Persist the current canvas so the AI works on what the user sees.
    const blob = await this.editSession.exportPngBlob();
    const saved = this.editSession.dirty()
      ? await this.store.saveEdit(blob, item.id)
      : item;
    const prompt =
      req.toolId === 'edit-fill' ? req.prompt
      : req.toolId === 'edit-remove' ? 'remove the masked object and seamlessly continue the background'
      : req.toolId === 'edit-expand' ? 'continue the image naturally beyond its original edges'
      : 'remove background';
    await this.store.create({
      familyId: req.toolId,
      op: GenerationOp.Edit,
      prompt,
      settings: saved.settings,
      batch: 1,
      parentId: saved.id,
      maskPngBase64: mask,
    });
    this.viewport()?.maskCanvas()?.clear();
    this.notice.set('');
    this.poller.watch();
  } catch (e) {
    this.showError(e, 'Edit failed');
  }
}
```

`openWithBufferFromCurrent(saved)` = small EditSession helper: keep the current engine/pixels but swap the `item` signal to the saved row (add it in this task):

```ts
/** After a save: keep editing the same pixels under the new version's identity. */
adoptItem(saved: GenerationDto): void {
  this.itemSig.set(saved);
  this.dirtySig.set(false);
}
```

(use `adoptItem` — fix the call above to `this.editSession.adoptItem(saved)`).

`workspace-page.html`: mount the panel to the right of `.main-col` (inside `.shell`):

```html
<app-studio-panel
  [editing]="mode() === 'edit'"
  (saveRequested)="onSaveEdit()"
  (aiToolRequested)="onAiTool($event)"
  (subscribeRequested)="reactivateStudio()"
/>
```

StudioPanel gets `subscribeRequested = output<void>()`; the lock-card button emits it (NOT `saveRequested` as the Step 2 html draft shows — fix that button to `(click)="subscribeRequested.emit()"`).

**Expand pre-padding** (client builds the padded image + border mask before calling the tool). Add to `onAiTool` before the save/create block, replacing the plain export for `edit-expand`:

```ts
// Expand: pad the canvas 25% on every side; FLUX fill repaints the padding
// (mask = white border). The padded PNG becomes the saved parent version.
if (req.toolId === 'edit-expand') {
  const buf = this.editSession.current()!;
  const padX = Math.round(buf.width * 0.25);
  const padY = Math.round(buf.height * 0.25);
  const w = buf.width + padX * 2;
  const h = buf.height + padY * 2;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  ctx.putImageData(
    new ImageData(new Uint8ClampedArray(buf.data), buf.width, buf.height), padX, padY,
  );
  const padded = await canvas.convertToBlob({ type: 'image/png' });
  const maskCanvas = new OffscreenCanvas(w, h);
  const mctx = maskCanvas.getContext('2d')!;
  mctx.fillStyle = '#fff';
  mctx.fillRect(0, 0, w, h);
  mctx.fillStyle = '#000';
  mctx.fillRect(padX, padY, buf.width, buf.height);
  const maskBlob = await maskCanvas.convertToBlob({ type: 'image/png' });
  const expandMask = await blobToDataUrl(maskBlob);
  const saved = await this.store.saveEdit(padded, item.id);
  await this.store.create({
    familyId: req.toolId,
    op: GenerationOp.Edit,
    prompt: 'continue the image naturally beyond its original edges',
    settings: saved.settings,
    batch: 1,
    parentId: saved.id,
    maskPngBase64: expandMask,
  });
  this.poller.watch();
  return;
}
```

with the helper (bottom of workspace-page.ts):

```ts
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
```

(Note: `/edits/save` treats the padded PNG as a normal $0 version — fine; the AI result chains off it.)

New `.shell` grid column in `workspace-page.css`: the shell is currently sidebar + main; append the studio rail as a third column (`grid-template-columns: 300px 1fr 240px` or the flex equivalent matching current layout — inspect existing CSS and extend it).

AI-result handoff: when the poller flips a pending edit-tool generation to done, the user is still in edit mode looking at the pre-AI canvas. Listen via an `effect()` in workspace: if `mode()==='edit'` and a done generation appears whose `parentId` chain includes the session item id and `familyId` starts with `edit-`, show notice “AI edit ready — opening result” and `void this.enterEdit(newId)`.

- [ ] **Step 5: Build + tests + manual run-through** — `npx ng build`, `npx vitest run`, then in the browser: adjust/sharpen/smooth/rotate apply and undo/redo; save creates a $0 “Studio Edit” version in the grid; edit-bg on a saved image completes and opens; non-Studio account (SQL: set subscription status canceled) sees locked panel with CTA.

- [ ] **Step 6: Report task done.**

---

### Task 8: Video lock (Pro teaser), docs, final verification

**Files:**
- Modify: `src/app/features/workspace/settings-rail/settings-rail.ts` / `.html`
- Modify: `vansen.md`, `CLAUDE.md`

**Interfaces:** none new.

- [ ] **Step 1: Video lock.** In settings-rail: the Image|Video mode toggle's Video button becomes locked (all users this phase — video generation is Phase 4b / Pro):

`settings-rail.ts`:

```ts
/** Video generation ships with the Pro tier (Phase 4b) — locked teaser until then. */
readonly videoLocked = true;

setMode(kind: ModelKind): void {
  if (kind === 'video' && this.videoLocked) return;
  this.mode.set(kind);
  this.selectFamily(firstFamilyOf(kind).id);
}
```

`settings-rail.html` — on the Video mode button: add `[class.mode-locked]="videoLocked"`, `[attr.title]="videoLocked ? 'Video — coming with Pro' : null"`, and a small `lucideLock` icon next to the label when locked (icon already needs adding to `provideIcons`). Constructor: if `prefs.defaultMode === 'video'`, force `'image'` while locked.

- [ ] **Step 2: Docs.**
- `vansen.md`: Phase 3b section — Studio editing panel live: local tools free (crop/adjust/sharpen/smooth/liquify/heal/mask), AI tools fixed retail ($0.10 remove/fill/expand, $0.05 bg), `/edits/save` $0 versions, Studio-gated right panel, Pro/video teaser locked, video → Phase 4b.
- `CLAUDE.md` backend section: add one line: “Studio editing (Phase 3b): `POST /edits/save` ($0 versions, Studio-gated, moderated); edit tools `edit-remove|edit-fill|edit-expand|edit-bg` = fixed retail prices in `EDIT_TOOLS`, fal fill/birefnet, kill-switch rows in `models`.”

- [ ] **Step 3: Full verification** — `npx vitest run` (all green), `npx ng build` (clean), re-run scratchpad `e2e-edits.mjs` once more end-to-end. Report results; user commits.
