# Studio & Pro Tools Expansion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 10 new Studio filter looks and 6 new commercial-safe Pro tools, and make all local editing preview smoothly on large images.

**Architecture:** Pure-pixel ops live in `src/app/core/editing/ops/` (take a `PixelBuffer`, return a new one, alpha untouched) and are dispatched through the existing Web Worker (`edit-worker.ts` → `runOpSync`). Heavy ML runs as lazily-imported ONNX engines in `src/app/core/editing/engines/` via the shared `model-loader.ts` (download-once → Cache Storage → WebGPU-then-wasm). Tools are registered in `studio-panel.ts` and their parameter UI + preview/apply wiring lives in `tool-options.ts`. Live previews already run debounced on a memoized downscaled proxy (`EditSession.previewOp(kind, params, maxDim?)`); the perf work extends that proxy to the color/filter tools and replaces the fixed debounce with animation-frame coalescing.

**Tech Stack:** Angular 22 (standalone, signals, OnPush), TypeScript, Canvas2D / OffscreenCanvas, `onnxruntime-web`, `@ng-icons/lucide`, vitest via `@angular/build:unit-test`.

## Global Constraints

- **Never commit / branch / push.** The user makes all commits personally on a single branch. Every task ends by staging changes for the user to review — do NOT run `git commit`. (Overrides the skill's commit steps.)
- Angular components use separate `.ts` + `.html` + `.css` files. Never inline templates or styles. Prefer stylesheet classes over inline `style`.
- **License policy (non-negotiable):** ship engines commercial-safe for BOTH code and weights. Confirmed clean: NAFNet (MIT), DDColor (Apache-2.0), plus existing SlimSAM/MI-GAN/Depth-Anything-small/ISNet/Swin2SR. BANNED (non-commercial weights): GFPGAN, CodeFormer, MODNet weights, face-parsing weights (CelebA), RMBG/bria, AGPL ISNet mirror, Depth-Anything B/L. No dedicated face-restoration ML — portrait value is a classical weight-free op.
- Provider/API keys never in the repo (not relevant here — all client-side, no new backend).
- Build: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use 22.23.1 >/dev/null && npx ng build`
- Test: `npm test` (Angular unit-test builder; vitest-backed, TestBed-aware). Bare `npx vitest run` falsely fails TestBed specs — do not use it.
- Pro tools stay unlocked while testing (`proLocked = signal(false)` in `studio-panel.ts`). Do NOT wire the real Pro gate until the user says these passed testing.
- Every new ONNX model's source URL + license + size gets recorded in the CLAUDE.md engine ledger.

## File Structure

**Created:**
- `src/app/core/editing/ops/dehaze.ts` — dark-channel-prior dehaze (pure op).
- `src/app/core/editing/ops/portrait-smooth.ts` — frequency-separation skin smooth (pure op).
- `src/app/core/editing/engines/denoise-engine.ts` — NAFNet denoise + deblur ONNX (tiled).
- `src/app/core/editing/engines/colorize-engine.ts` — DDColor colorization ONNX.
- `src/app/core/editing/preview-scheduler.ts` — animation-frame-coalesced preview runner (shared).

**Modified:**
- `src/app/core/editing/ops/filters.ts` — 9 new presets + duotone color params.
- `src/app/core/editing/edit-worker.ts` — register `dehaze`, `portraitSmooth` worker ops.
- `src/app/core/editing/engines/engine-status.ts` — progress signals for new engines.
- `src/app/features/studio/studio-tool.ts` — new tool ids + drag set.
- `src/app/features/studio/studio-panel/studio-panel.ts` + `.html` — register 6 Pro tools + icons.
- `src/app/features/studio/tool-options/tool-options.ts` + `.html` + `.css` — preset chips, sliders, preview/apply, engine wiring, rAF scheduler adoption.
- `src/app/core/editing/ops/ops.spec.ts` — tests for new ops + filters.
- `CLAUDE.md` — engine ledger entries for NAFNet + DDColor.

**Phases (execution order):** 1 Perf foundation → 2 Filters → 3 Classical Pro ops + Magic Erase → 4 ONNX engines → 5 Verify. Phases 1–3 need no external models and are fully testable now. Phase 4 is gated on sourcing commercial ONNX exports and may run as a separate execution pass.

---

## Phase 1 — Perf foundation

### Task 1: Proxy-downscale the color/filter previews

Geometry previews (`straighten`, `perspective`) already run on a ≤1100px proxy; the color/adjust/filter/levels/enhance/sharpen/smooth previews run at full resolution, which is what makes slider drags feel laggy on large images. Route them through the same proxy. Apply stays full-res.

**Files:**
- Modify: `src/app/features/studio/tool-options/tool-options.ts` (`runPreview`, `PREVIEW_MAX_DIM`)
- Test: `src/app/core/editing/edit-session.spec.ts`

**Interfaces:**
- Consumes: `EditSession.previewOp(kind: WorkerOp['kind'], params: unknown, maxDim?: number): Promise<void>` (already exists), `EditSession.previewBuffer()` signal.
- Produces: no new signatures; behavioral change only.

- [ ] **Step 1: Write the failing test**

Add to `src/app/core/editing/edit-session.spec.ts` (follow the existing `openWithBuffer` setup in that file):

```ts
it('previewOp downscales the preview buffer when maxDim is smaller than the image', async () => {
  const session = TestBed.inject(EditSession);
  const big: PixelBuffer = { width: 2000, height: 1000, data: new Uint8ClampedArray(2000 * 1000 * 4) };
  session.openWithBuffer({ id: 'x' } as GenerationDto, big);
  await session.previewOp('filter', { preset: 'bw', intensity: 100 }, 1100);
  const prev = session.previewBuffer()!;
  expect(Math.max(prev.width, prev.height)).toBeLessThanOrEqual(1100);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — preview buffer is 2000px wide (no maxDim passed through today for filter).

Note: this test exercises `previewOp` directly, which already supports `maxDim`; it fails only if you first assert the tool wiring omits it. If it passes immediately, that confirms `previewOp` is correct and Step 3 is purely the `tool-options` change — keep the test as a regression guard and proceed.

- [ ] **Step 3: Route color/filter previews through the proxy**

In `tool-options.ts`, add the `maxDim` argument to every `previewOp` call inside `runPreview` that currently omits it (`adjust`, `sharpen`, `smooth`, `filter`, `enhance`, `levels`). Example — change:

```ts
} else if (t === 'filters') {
  await this.session.previewOp('filter', {
    preset: this.filterPreset(),
    intensity: this.filterIntensity(),
  });
}
```

to:

```ts
} else if (t === 'filters') {
  await this.session.previewOp('filter', {
    preset: this.filterPreset(),
    intensity: this.filterIntensity(),
  }, PREVIEW_MAX_DIM);
}
```

Do the same for `adjust`, `sharpen`, `smooth`, `enhance`, `levels`. Leave the already-proxied `straighten`/`perspective` calls unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS. Full-res correctness is unaffected because Apply (`session.apply`) never uses the proxy.

- [ ] **Step 5: Stage for review** (do NOT commit)

Run: `git add src/app/features/studio/tool-options/tool-options.ts src/app/core/editing/edit-session.spec.ts`
Then tell the user this task is ready to review.

---

### Task 2: Animation-frame-coalesced preview scheduler

Replace the fixed `setTimeout(..., 80)` debounce with a scheduler that coalesces rapid slider input into one compute per animation frame and drops stale frames. Smoother than a fixed delay and self-tuning to the device.

**Files:**
- Create: `src/app/core/editing/preview-scheduler.ts`
- Test: `src/app/core/editing/preview-scheduler.spec.ts`
- Modify: `src/app/features/studio/tool-options/tool-options.ts` (`schedulePreview`, `previewTimer`, `DestroyRef` cleanup)

**Interfaces:**
- Produces:
  - `class PreviewScheduler { constructor(run: () => void | Promise<void>); schedule(): void; cancel(): void; }`
  - `schedule()` requests one run on the next frame; extra calls before it fires collapse into that single run. `cancel()` drops a pending run.

- [ ] **Step 1: Write the failing test**

Create `src/app/core/editing/preview-scheduler.spec.ts`:

```ts
import { PreviewScheduler } from './preview-scheduler';

describe('PreviewScheduler', () => {
  it('collapses many schedule() calls into one run per frame', async () => {
    const rafQueue: FrameRequestCallback[] = [];
    const raf = (cb: FrameRequestCallback) => { rafQueue.push(cb); return rafQueue.length; };
    let runs = 0;
    const s = new PreviewScheduler(() => { runs++; }, raf, () => {});
    s.schedule(); s.schedule(); s.schedule();
    expect(runs).toBe(0);            // nothing runs synchronously
    rafQueue.shift()!(0);            // fire the single queued frame
    expect(runs).toBe(1);            // three schedules → one run
  });

  it('cancel() prevents a pending run', () => {
    const rafQueue: FrameRequestCallback[] = [];
    const raf = (cb: FrameRequestCallback) => { rafQueue.push(cb); return rafQueue.length; };
    let runs = 0;
    const s = new PreviewScheduler(() => { runs++; }, raf, () => {});
    s.schedule();
    s.cancel();
    rafQueue.shift()?.(0);
    expect(runs).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './preview-scheduler'`.

- [ ] **Step 3: Implement the scheduler**

Create `src/app/core/editing/preview-scheduler.ts`:

```ts
/**
 * Coalesces bursty preview requests (slider drags) into one run per animation
 * frame, dropping stale intermediate frames. raf/caf are injectable for tests.
 */
export class PreviewScheduler {
  private handle: number | null = null;

  constructor(
    private readonly run: () => void | Promise<void>,
    private readonly raf: (cb: FrameRequestCallback) => number =
      (cb) => requestAnimationFrame(cb),
    private readonly caf: (h: number) => void =
      (h) => cancelAnimationFrame(h),
  ) {}

  schedule(): void {
    if (this.handle !== null) return; // a frame is already queued — coalesce
    this.handle = this.raf(() => {
      this.handle = null;
      void this.run();
    });
  }

  cancel(): void {
    if (this.handle !== null) {
      this.caf(this.handle);
      this.handle = null;
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Adopt it in tool-options**

In `tool-options.ts`:
- Remove the `private previewTimer` field and every `clearTimeout(this.previewTimer)` / `setTimeout(...)` in `schedulePreview`, `scheduleBokehPreview`, `resetPending`, the Apply methods, and the `DestroyRef` cleanup.
- Add a field: `private readonly previewSched = new PreviewScheduler(() => this.runPreview());`
- Replace `schedulePreview()` body with:

```ts
schedulePreview(): void {
  this.previewSched.schedule();
}
```

- In each Apply method, replace `clearTimeout(this.previewTimer);` with `this.previewSched.cancel();`.
- In `resetPending()`, replace `clearTimeout(this.previewTimer);` with `this.previewSched.cancel();`.
- In the `DestroyRef.onDestroy` callback, replace `clearTimeout(this.previewTimer);` with `this.previewSched.cancel();`.
- Bokeh keeps its own 150ms `setTimeout` for now (its compute is heavier and network-gated); leave `scheduleBokehPreview` on a private timer field renamed `bokehTimer` to avoid confusion. Add `private bokehTimer?: ReturnType<typeof setTimeout>;` and update `scheduleBokehPreview`/cleanup to use it.

- [ ] **Step 6: Run build + tests**

Run: `npm test` then the build command.
Expected: both green. Manually confirm no remaining reference to `previewTimer`.

- [ ] **Step 7: Stage for review** (do NOT commit)

Run: `git add src/app/core/editing/preview-scheduler.ts src/app/core/editing/preview-scheduler.spec.ts src/app/features/studio/tool-options/tool-options.ts`

---

## Phase 2 — Filters expansion

### Task 3: Add 10 filter presets + duotone color params

**Files:**
- Modify: `src/app/core/editing/ops/filters.ts`
- Test: `src/app/core/editing/ops/ops.spec.ts`

**Interfaces:**
- Produces: `FilterPreset` union extended with `'fade' | 'noir' | 'matte' | 'tealorange' | 'goldenhour' | 'crossprocess' | 'infrared' | 'bleach' | 'duotone' | 'clarity'`. `FilterParams` gains optional `colorA?: [number, number, number]` and `colorB?: [number, number, number]` (only read by `duotone`). Existing `filter(buf, params)` signature unchanged. `clarity` needs a blurred-luminance map precomputed before the per-pixel loop (new private helper `blurredLuminance` in `filters.ts`).

- [ ] **Step 1: Write the failing tests**

Add to `ops.spec.ts` (it already imports `filter`; follow the existing filter test style — small fixed buffer, assert invariants):

```ts
describe('filter — new presets', () => {
  const px = (r: number, g: number, b: number): PixelBuffer => ({
    width: 1, height: 1, data: new Uint8ClampedArray([r, g, b, 255]),
  });
  const presets = ['fade','noir','matte','tealorange','goldenhour','crossprocess','infrared','bleach','duotone','clarity'] as const;

  it('intensity 0 is identity for every new preset', () => {
    for (const preset of presets) {
      const out = filter(px(120, 90, 60), { preset, intensity: 0 });
      expect([out.data[0], out.data[1], out.data[2]]).toEqual([120, 90, 60]);
    }
  });

  it('keeps alpha untouched and stays in 0..255', () => {
    for (const preset of presets) {
      const out = filter(px(200, 40, 10), { preset, intensity: 100 });
      expect(out.data[3]).toBe(255);
      for (let c = 0; c < 3; c++) expect(out.data[c]).toBeGreaterThanOrEqual(0);
    }
  });

  it('duotone maps luminance between colorA (shadow) and colorB (highlight)', () => {
    const black = filter(px(0, 0, 0), { preset: 'duotone', intensity: 100, colorA: [10, 20, 30], colorB: [240, 230, 220] });
    const white = filter(px(255, 255, 255), { preset: 'duotone', intensity: 100, colorA: [10, 20, 30], colorB: [240, 230, 220] });
    expect([black.data[0], black.data[1], black.data[2]]).toEqual([10, 20, 30]);
    expect([white.data[0], white.data[1], white.data[2]]).toEqual([240, 230, 220]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — the new preset strings aren't in the union / `switch`, so TypeScript errors and/or the identity assertion fails.

- [ ] **Step 3: Extend the union + params**

In `filters.ts`, replace the type declarations at the top:

```ts
export type FilterPreset =
  | 'bw' | 'sepia' | 'vintage' | 'warm' | 'cool' | 'grain' | 'vignette'
  | 'fade' | 'noir' | 'matte' | 'tealorange' | 'goldenhour'
  | 'crossprocess' | 'infrared' | 'bleach' | 'duotone' | 'clarity';

export interface FilterParams {
  preset: FilterPreset;
  /** 0..100 — blends the untouched pixels toward the full effect. */
  intensity: number;
  /** duotone only: shadow tint (RGB 0..255). Defaults to a deep indigo. */
  colorA?: [number, number, number];
  /** duotone only: highlight tint (RGB 0..255). Defaults to a warm cream. */
  colorB?: [number, number, number];
}
```

- [ ] **Step 4: Add the switch cases**

Inside the `switch (p.preset)` in `filter()`, add these cases (the existing trailing `d[i] = r + (nr - r) * mix; ...` blend applies to all, so each case only sets `nr/ng/nb`):

```ts
case 'fade': {
  const lift = 18;
  let fr = lift + r * (1 - lift / 255);
  let fg = lift + g * (1 - lift / 255);
  let fb = lift + b * (1 - lift / 255);
  fr = (fr - 128) * 0.85 + 128;
  fg = (fg - 128) * 0.85 + 128;
  fb = (fb - 128) * 0.85 + 128;
  const gray = 0.2126 * fr + 0.7152 * fg + 0.0722 * fb;
  nr = gray + (fr - gray) * 0.85;
  ng = gray + (fg - gray) * 0.85;
  nb = gray + (fb - gray) * 0.85;
  break;
}
case 'noir': {
  const gray = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  nr = ng = nb = (gray - 128) * 1.35 + 118;
  break;
}
case 'matte': {
  const soft = (v: number) => 128 + (v - 128) * 0.82;
  nr = Math.min(soft(r) + 6, 238);
  ng = Math.min(soft(g) + 3, 238);
  nb = Math.min(soft(b) - 2, 238);
  break;
}
case 'tealorange': {
  const gray = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const shadow = 1 - smoothstep(0, 160, gray);
  const high = smoothstep(96, 255, gray);
  nr = r + high * 20 - shadow * 12;
  ng = g + high * 6 - shadow * 2;
  nb = b - high * 18 + shadow * 22;
  break;
}
case 'goldenhour':
  nr = r * 1.06 + 14;
  ng = g * 1.01 + 6;
  nb = b * 0.92 - 6;
  break;
case 'crossprocess': {
  const curve = (v: number) => {
    const t = v / 255;
    return (t + 0.5 * t * (1 - t) * (t - 0.5) * -4) * 255;
  };
  nr = curve(r);
  ng = curve(g) + 6;
  nb = curve(b) + 8;
  break;
}
case 'infrared': {
  const gray = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  nr = g * 0.7 + gray * 0.3;
  ng = b * 0.6 + gray * 0.2;
  nb = r * 0.5 + gray * 0.3;
  break;
}
case 'bleach': {
  const gray = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const overlay = (base: number) => {
    const bl = base / 255;
    const gl = gray / 255;
    const o = gl < 0.5 ? 2 * bl * gl : 1 - 2 * (1 - bl) * (1 - gl);
    return o * 255;
  };
  nr = r * 0.5 + overlay(r) * 0.5;
  ng = g * 0.5 + overlay(g) * 0.5;
  nb = b * 0.5 + overlay(b) * 0.5;
  break;
}
case 'duotone': {
  const a = p.colorA ?? [26, 22, 55];
  const c2 = p.colorB ?? [245, 226, 168];
  const gl = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  nr = a[0] + (c2[0] - a[0]) * gl;
  ng = a[1] + (c2[1] - a[1]) * gl;
  nb = a[2] + (c2[2] - a[2]) * gl;
  break;
}
case 'clarity': {
  // blurLum precomputed before the loop (see below).
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const boost = (lum - blurLum![y * w + x]) * 0.6;
  nr = r + boost;
  ng = g + boost;
  nb = b + boost;
  break;
}
```

`clarity` needs local contrast, which a per-pixel switch can't see — precompute a
blurred-luminance map once, before the `for (let y ...)` loop (right after the
`rand` line):

```ts
// Local-contrast base for `clarity` — computed once, not per pixel.
const blurLum = p.preset === 'clarity'
  ? blurredLuminance(buf, Math.max(2, Math.round(Math.min(w, h) / 50)))
  : null;
```

And add the helper at module level (next to `smoothstep`):

```ts
/** Separable box-blurred luminance map, edges clamped. */
function blurredLuminance(buf: PixelBuffer, radius: number): Float32Array {
  const { width: w, height: h, data } = buf;
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const q = i * 4;
    lum[i] = 0.2126 * data[q] + 0.7152 * data[q + 1] + 0.0722 * data[q + 2];
  }
  const win = radius * 2 + 1;
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += lum[y * w + Math.min(w - 1, Math.max(0, k))];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = sum / win;
      const add = Math.min(w - 1, x + radius + 1);
      const sub = Math.max(0, x - radius);
      sum += lum[y * w + add] - lum[y * w + sub];
    }
  }
  const out = new Float32Array(w * h);
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += tmp[Math.min(h - 1, Math.max(0, k)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / win;
      const add = Math.min(h - 1, y + radius + 1);
      const sub = Math.max(0, y - radius);
      sum += tmp[add * w + x] - tmp[sub * w + x];
    }
  }
  return out;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (all three new specs + existing filter specs).

- [ ] **Step 6: Stage for review** (do NOT commit)

Run: `git add src/app/core/editing/ops/filters.ts src/app/core/editing/ops/ops.spec.ts`

---

### Task 4: Wire the new filter chips + duotone swatches into the UI

**Files:**
- Modify: `src/app/features/studio/tool-options/tool-options.ts` (`FILTER_PRESETS`, duotone color signals, `runPreview`/`applyFilter`)
- Modify: `src/app/features/studio/tool-options/tool-options.html` (filters `@case`)
- Modify: `src/app/features/studio/tool-options/tool-options.css` (swatch styles)

**Interfaces:**
- Consumes: `FilterPreset`, `filterPreset` signal, `selectFilter()`, `schedulePreview()` (all exist).
- Produces: `duotoneA`/`duotoneB` `signal<[number, number, number]>`; `setDuotone(which: 'a' | 'b', hex: string)` method.

- [ ] **Step 1: Extend the preset list**

In `tool-options.ts`, extend `FILTER_PRESETS`:

```ts
const FILTER_PRESETS: { id: FilterPreset; label: string }[] = [
  { id: 'bw', label: 'B&W' },
  { id: 'sepia', label: 'Sepia' },
  { id: 'vintage', label: 'Vintage' },
  { id: 'warm', label: 'Warm' },
  { id: 'cool', label: 'Cool' },
  { id: 'grain', label: 'Film Grain' },
  { id: 'vignette', label: 'Vignette' },
  { id: 'fade', label: 'Fade' },
  { id: 'noir', label: 'Noir' },
  { id: 'matte', label: 'Matte' },
  { id: 'tealorange', label: 'Teal & Orange' },
  { id: 'goldenhour', label: 'Golden Hour' },
  { id: 'crossprocess', label: 'Cross Process' },
  { id: 'infrared', label: 'Infrared' },
  { id: 'bleach', label: 'Bleach Bypass' },
  { id: 'duotone', label: 'Duotone' },
  { id: 'clarity', label: 'Clarity' },
];
```

- [ ] **Step 2: Add duotone signals + helpers**

Add fields + method to `ToolOptions`:

```ts
readonly duotoneA = signal<[number, number, number]>([26, 22, 55]);
readonly duotoneB = signal<[number, number, number]>([245, 226, 168]);

hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

rgbToHex([r, g, b]: [number, number, number]): string {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

setDuotone(which: 'a' | 'b', hex: string): void {
  (which === 'a' ? this.duotoneA : this.duotoneB).set(this.hexToRgb(hex));
  this.schedulePreview();
}
```

Update the `filters` branch of `runPreview` and `applyFilter` to pass the colors:

```ts
// in runPreview, filters branch:
await this.session.previewOp('filter', {
  preset: this.filterPreset(),
  intensity: this.filterIntensity(),
  colorA: this.duotoneA(),
  colorB: this.duotoneB(),
}, PREVIEW_MAX_DIM);
```

```ts
// applyFilter:
await this.session.apply('filter', {
  preset: this.filterPreset(),
  intensity: this.filterIntensity(),
  colorA: this.duotoneA(),
  colorB: this.duotoneB(),
});
```

- [ ] **Step 3: Add the swatch UI**

In `tool-options.html`, inside the existing filters `@case` (after the preset chips loop, before/after the intensity slider — match the surrounding markup), add:

```html
@if (filterPreset() === 'duotone') {
  <div class="duotone-row">
    <label class="duotone-swatch">
      Shadows
      <input type="color" [value]="rgbToHex(duotoneA())"
             (input)="setDuotone('a', $any($event.target).value)" />
    </label>
    <label class="duotone-swatch">
      Highlights
      <input type="color" [value]="rgbToHex(duotoneB())"
             (input)="setDuotone('b', $any($event.target).value)" />
    </label>
  </div>
}
```

In `tool-options.css` add:

```css
.duotone-row { display: flex; gap: 12px; margin-top: 10px; }
.duotone-swatch {
  display: flex; flex-direction: column; gap: 4px;
  font-size: 0.75rem; color: var(--muted-foreground);
}
.duotone-swatch input[type='color'] {
  width: 100%; height: 28px; border: 1px solid var(--border);
  border-radius: calc(var(--radius) - 4px); background: transparent; cursor: pointer;
}
```

- [ ] **Step 4: Verify in the browser**

Run the build, then the preview verification workflow (dev server via `preview_start` with the app's launch config): open Filters, confirm all 17 chips render, each previews live, Duotone reveals two color pickers that update the preview, Apply commits. Capture a screenshot for the user.

Note: if the app's login gate blocks preview in this environment, skip the browser step and report that manual in-app verification is needed; the build + unit tests must still pass.

- [ ] **Step 5: Stage for review** (do NOT commit)

Run: `git add src/app/features/studio/tool-options/`

---

## Phase 3 — Classical Pro ops + Magic Erase

### Task 5: Dehaze op (dark-channel prior)

**Files:**
- Create: `src/app/core/editing/ops/dehaze.ts`
- Modify: `src/app/core/editing/edit-worker.ts`
- Test: `src/app/core/editing/ops/ops.spec.ts`

**Interfaces:**
- Produces: `interface DehazeParams { strength: number }` (0..100); `function dehaze(buf: PixelBuffer, p: DehazeParams): PixelBuffer`. Worker op `{ kind: 'dehaze'; buffer: PixelBuffer; params: DehazeParams }`.

- [ ] **Step 1: Write the failing test**

Add to `ops.spec.ts`:

```ts
import { dehaze } from './dehaze';

describe('dehaze', () => {
  const hazy: PixelBuffer = {
    width: 4, height: 4,
    data: new Uint8Array(4 * 4 * 4).map((_, i) => (i % 4 === 3 ? 255 : 180)) as unknown as Uint8ClampedArray,
  };
  it('strength 0 is identity', () => {
    const out = dehaze(hazy, { strength: 0 });
    expect(Array.from(out.data)).toEqual(Array.from(hazy.data));
  });
  it('increases contrast (widens the value range) at full strength', () => {
    const graded: PixelBuffer = {
      width: 4, height: 4,
      data: new Uint8ClampedArray(Array.from({ length: 64 }, (_, i) =>
        i % 4 === 3 ? 255 : 120 + ((i >> 2) % 16) * 4)),
    };
    const out = dehaze(graded, { strength: 100 });
    const range = (d: ArrayLike<number>) => {
      let lo = 255, hi = 0;
      for (let i = 0; i < d.length; i++) if (i % 4 !== 3) { lo = Math.min(lo, d[i]); hi = Math.max(hi, d[i]); }
      return hi - lo;
    };
    expect(range(out.data)).toBeGreaterThanOrEqual(range(graded.data));
    expect(out.data[3]).toBe(255);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './dehaze'`.

- [ ] **Step 3: Implement dehaze**

Create `src/app/core/editing/ops/dehaze.ts`:

```ts
import { PixelBuffer, clonePixels } from '../pixel-buffer';

export interface DehazeParams {
  /** 0..100 — how aggressively to remove haze. */
  strength: number;
}

/** Single-image dehazing via the dark-channel prior (He et al.). Alpha untouched. */
export function dehaze(buf: PixelBuffer, p: DehazeParams): PixelBuffer {
  const mix = Math.min(100, Math.max(0, p.strength)) / 100;
  if (mix === 0) return clonePixels(buf);
  const { width: w, height: h, data: src } = buf;
  const n = w * h;

  // Per-pixel min over RGB, then a min-filter → the dark channel.
  const minRgb = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const q = i * 4;
    minRgb[i] = Math.min(src[q], src[q + 1], src[q + 2]);
  }
  const rad = Math.max(1, Math.round(Math.min(w, h) / 100));
  const dark = minFilter(minRgb, w, h, rad);

  // Atmospheric light: average source color over the brightest 0.1% of dark px.
  const A = atmosphere(src, dark, n);
  const aGray = Math.max(1, (A[0] + A[1] + A[2]) / 3);
  const omega = 0.95;

  const out = clonePixels(buf);
  const d = out.data;
  for (let i = 0; i < n; i++) {
    const t = Math.max(0.1, 1 - omega * (dark[i] / aGray));
    const q = i * 4;
    for (let c = 0; c < 3; c++) {
      const j = (src[q + c] - A[c]) / t + A[c];
      d[q + c] = src[q + c] + (j - src[q + c]) * mix;
    }
  }
  return out;
}

/** Separable min over a (2r+1) window, edges clamped. */
function minFilter(m: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = Infinity;
      for (let k = -r; k <= r; k++) {
        const sx = Math.min(w - 1, Math.max(0, x + k));
        v = Math.min(v, m[y * w + sx]);
      }
      tmp[y * w + x] = v;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = Infinity;
      for (let k = -r; k <= r; k++) {
        const sy = Math.min(h - 1, Math.max(0, y + k));
        v = Math.min(v, tmp[sy * w + x]);
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

function atmosphere(src: ArrayLike<number>, dark: Float32Array, n: number): [number, number, number] {
  const count = Math.max(1, Math.floor(n * 0.001));
  // Indices of the `count` largest dark-channel values.
  const idx = Array.from({ length: n }, (_, i) => i)
    .sort((a, b) => dark[b] - dark[a])
    .slice(0, count);
  let r = 0, g = 0, b = 0;
  for (const i of idx) {
    const q = i * 4;
    r += src[q]; g += src[q + 1]; b += src[q + 2];
  }
  return [r / count, g / count, b / count];
}
```

- [ ] **Step 4: Register the worker op**

In `edit-worker.ts`: add the import `import { DehazeParams, dehaze } from './ops/dehaze';`, add to the `WorkerOp` union `| { kind: 'dehaze'; buffer: PixelBuffer; params: DehazeParams }`, and add to `runOpSync` the case `case 'dehaze': return dehaze(op.buffer, op.params);`.

- [ ] **Step 5: Run tests + build**

Run: `npm test` then the build command.
Expected: PASS + green build.

- [ ] **Step 6: Stage for review** (do NOT commit)

Run: `git add src/app/core/editing/ops/dehaze.ts src/app/core/editing/edit-worker.ts src/app/core/editing/ops/ops.spec.ts`

---

### Task 6: Portrait Smooth op (frequency separation)

**Files:**
- Create: `src/app/core/editing/ops/portrait-smooth.ts`
- Modify: `src/app/core/editing/edit-worker.ts`
- Test: `src/app/core/editing/ops/ops.spec.ts`

**Interfaces:**
- Produces: `interface PortraitSmoothParams { strength: number }` (0..100); `function portraitSmooth(buf: PixelBuffer, p: PortraitSmoothParams): PixelBuffer`. Worker op `{ kind: 'portraitSmooth'; buffer: PixelBuffer; params: PortraitSmoothParams }`.

- [ ] **Step 1: Write the failing test**

Add to `ops.spec.ts`:

```ts
import { portraitSmooth } from './portrait-smooth';

describe('portraitSmooth', () => {
  it('strength 0 is identity', () => {
    const buf: PixelBuffer = { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4).fill(150) };
    for (let i = 3; i < buf.data.length; i += 4) buf.data[i] = 255;
    const out = portraitSmooth(buf, { strength: 0 });
    expect(Array.from(out.data)).toEqual(Array.from(buf.data));
  });
  it('reduces high-frequency variance on skin-tone noise, keeps alpha', () => {
    // Skin-ish base with per-pixel speckle.
    const w = 16, h = 16;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const q = i * 4;
      const n = (i % 2 ? 12 : -12);
      data[q] = 200 + n; data[q + 1] = 150 + n; data[q + 2] = 120 + n; data[q + 3] = 255;
    }
    const buf: PixelBuffer = { width: w, height: h, data };
    const out = portraitSmooth(buf, { strength: 100 });
    const variance = (d: ArrayLike<number>) => {
      let s = 0, s2 = 0, count = 0;
      for (let i = 0; i < d.length; i += 4) { s += d[i]; s2 += d[i] * d[i]; count++; }
      return s2 / count - (s / count) ** 2;
    };
    expect(variance(out.data)).toBeLessThan(variance(buf.data));
    expect(out.data[3]).toBe(255);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './portrait-smooth'`.

- [ ] **Step 3: Implement portrait smooth**

Create `src/app/core/editing/ops/portrait-smooth.ts`:

```ts
import { PixelBuffer, clonePixels } from '../pixel-buffer';

export interface PortraitSmoothParams {
  /** 0..100 — how much pore/blemish detail to soften. */
  strength: number;
}

/**
 * Frequency-separation skin smoothing: blur to the low band, attenuate only the
 * small-amplitude high-frequency detail on skin-tone pixels, keep edges/features.
 * No ML weights — fully commercial-clean. Alpha untouched.
 */
export function portraitSmooth(buf: PixelBuffer, p: PortraitSmoothParams): PixelBuffer {
  const mix = Math.min(100, Math.max(0, p.strength)) / 100;
  if (mix === 0) return clonePixels(buf);
  const { width: w, height: h, data: src } = buf;
  const radius = Math.max(1, Math.round(Math.min(w, h) / 200) + 1);
  const low = boxBlur(buf, radius);
  const out = clonePixels(buf);
  const d = out.data;
  const thresh = 18; // detail bigger than this is an edge/feature — preserve it

  for (let i = 0; i < w * h; i++) {
    const q = i * 4;
    const r = src[q], g = src[q + 1], b = src[q + 2];
    const isSkin = r > 60 && g > 40 && b > 20 && r >= g && g >= b && r - b > 8;
    for (let c = 0; c < 3; c++) {
      const hf = src[q + c] - low.data[q + c];
      const keep = !isSkin || Math.abs(hf) > thresh ? 1 : 1 - mix * 0.85;
      d[q + c] = low.data[q + c] + hf * keep;
    }
  }
  return out;
}

/** Two-pass separable box blur (near-gaussian), edges clamped. */
function boxBlur(buf: PixelBuffer, radius: number): PixelBuffer {
  let out = buf;
  for (let pass = 0; pass < 2; pass++) out = blurAxis(blurAxis(out, radius, true), radius, false);
  return out;
}

function blurAxis(buf: PixelBuffer, radius: number, horizontal: boolean): PixelBuffer {
  const { width: w, height: h } = buf;
  const out = clonePixels(buf);
  const src = buf.data;
  const dst = out.data;
  const len = horizontal ? w : h;
  const lines = horizontal ? h : w;
  const stride = horizontal ? 4 : w * 4;
  const lineStride = horizontal ? w * 4 : 4;
  const win = radius * 2 + 1;
  for (let l = 0; l < lines; l++) {
    const base = l * lineStride;
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += src[base + Math.min(len - 1, Math.max(0, k)) * stride + c];
      for (let i = 0; i < len; i++) {
        dst[base + i * stride + c] = sum / win;
        const add = Math.min(len - 1, i + radius + 1);
        const sub = Math.max(0, i - radius);
        sum += src[base + add * stride + c] - src[base + sub * stride + c];
      }
    }
  }
  return out;
}
```

- [ ] **Step 4: Register the worker op**

In `edit-worker.ts`: import `import { PortraitSmoothParams, portraitSmooth } from './ops/portrait-smooth';`, add union member `| { kind: 'portraitSmooth'; buffer: PixelBuffer; params: PortraitSmoothParams }`, and case `case 'portraitSmooth': return portraitSmooth(op.buffer, op.params);`.

- [ ] **Step 5: Run tests + build**

Run: `npm test` then the build command.
Expected: PASS + green build.

- [ ] **Step 6: Stage for review** (do NOT commit)

Run: `git add src/app/core/editing/ops/portrait-smooth.ts src/app/core/editing/edit-worker.ts src/app/core/editing/ops/ops.spec.ts`

---

### Task 7: Register Dehaze + Portrait Smooth tools (ids, panel, UI)

**Files:**
- Modify: `src/app/features/studio/studio-tool.ts`
- Modify: `src/app/features/studio/studio-panel/studio-panel.ts`
- Modify: `src/app/features/studio/tool-options/tool-options.ts` + `.html`

**Interfaces:**
- Consumes: `EditSession.previewOp`/`apply`, `PreviewScheduler` (Task 2), `PREVIEW_MAX_DIM`.
- Produces: `StudioTool` gains `'dehaze' | 'portraitsmooth'`; `ToolOptions` gains `dehazeStrength`/`portraitStrength` signals + `applyDehaze()`/`applyPortrait()`; both added to `runPreview` and `resetPending`.

- [ ] **Step 1: Add the tool ids**

In `studio-tool.ts`, add `| 'dehaze'` and `| 'portraitsmooth'` to the `StudioTool` union. (Neither is a drag tool — leave `DRAG_TOOLS` unchanged.)

- [ ] **Step 2: Register in the panel**

In `studio-panel.ts`, import two Lucide icons (e.g. `lucideCloudFog` for dehaze, `lucideSmile` for portrait) — add them to the import list and `provideIcons({...})`. Add to `PRO_TOOLS`:

```ts
{ id: 'dehaze', label: 'Dehaze', icon: 'lucideCloudFog' },
{ id: 'portraitsmooth', label: 'Portrait Smooth', icon: 'lucideSmile' },
```

(Verify both icon names exist in `@ng-icons/lucide`; if a name differs, pick the closest existing one and keep the import/provide/usage spelling identical across all three places.)

- [ ] **Step 3: Add signals + preview/apply in tool-options.ts**

```ts
readonly dehazeStrength = signal(60);
readonly portraitStrength = signal(60);
```

In `runPreview`, add branches:

```ts
} else if (t === 'dehaze') {
  await this.session.previewOp('dehaze', { strength: this.dehazeStrength() }, PREVIEW_MAX_DIM);
} else if (t === 'portraitsmooth') {
  await this.session.previewOp('portraitSmooth', { strength: this.portraitStrength() }, PREVIEW_MAX_DIM);
}
```

Add apply methods:

```ts
async applyDehaze(): Promise<void> {
  this.previewSched.cancel();
  await this.session.apply('dehaze', { strength: this.dehazeStrength() });
}

async applyPortrait(): Promise<void> {
  this.previewSched.cancel();
  await this.session.apply('portraitSmooth', { strength: this.portraitStrength() });
}
```

In `resetPending`, add `this.dehazeStrength.set(60); this.portraitStrength.set(60);`.

- [ ] **Step 4: Add the UI cases**

In `tool-options.html`, add two `@case` blocks mirroring the existing single-slider tools (e.g. `sharpen`). Each has a range input bound to the strength signal with `(input)="schedulePreview()"` and an Apply button calling `applyDehaze()` / `applyPortrait()`. Match the existing slider + `.apply-btn` markup exactly.

- [ ] **Step 5: Verify build + browser**

Run the build. Then (if preview is reachable) open each tool, drag the slider, confirm smooth live preview and Apply commits; screenshot for the user. Otherwise report manual-verification-needed.

- [ ] **Step 6: Stage for review** (do NOT commit)

Run: `git add src/app/features/studio/`

---

### Task 8: Magic Erase (one-tap object removal)

Reuses the existing SlimSAM select engine + MI-GAN heal — no new model. One canvas tap → SAM mask → grow → `applyHeal`.

**Files:**
- Modify: `src/app/features/studio/studio-tool.ts` (id + drag set)
- Modify: `src/app/features/studio/studio-panel/studio-panel.ts` (register)
- Modify: `src/app/features/studio/tool-options/tool-options.ts` (`erase` handling in the pointPick effect + `runErase`)
- Modify: `src/app/features/studio/tool-options/tool-options.html` (erase `@case` hint)

**Interfaces:**
- Consumes: `smartSelect(buf, points)` and `SelectPoint` from `select-engine`; `dilateMask` from `raster`; `EditSession.applyHeal(mask)`, `EditSession.pointPick()`, `runEngine`.
- Produces: `StudioTool` gains `'erase'`; `ToolOptions.runErase(point: SelectPoint)`.

- [ ] **Step 1: Add id + drag membership**

In `studio-tool.ts`: add `| 'erase'` to `StudioTool`, and add `'erase'` to the `DRAG_TOOLS` set (it owns the click gesture like `select`).

- [ ] **Step 2: Register in the panel**

In `studio-panel.ts`, import `lucideEraser`, add to `provideIcons`, and add to `PRO_TOOLS`:

```ts
{ id: 'erase', label: 'Magic Erase', icon: 'lucideEraser' },
```

- [ ] **Step 3: Handle taps in the pointPick effect**

In `tool-options.ts`, extend the existing `pointPick` effect's `untracked` block with an `erase` branch alongside `bokeh`/`select`:

```ts
} else if (t === 'erase') {
  void this.runErase({ x: pick.x, y: pick.y, label: 1 });
}
```

Add the method:

```ts
/** Magic Erase: tap an object → SAM mask → grow → MI-GAN inpaint it away. */
private async runErase(point: SelectPoint): Promise<void> {
  await this.runEngine(async () => {
    const buf = this.session.current();
    if (!buf) return;
    const { smartSelect } = await import('../../../core/editing/engines/select-engine');
    const mask = await smartSelect(buf, [point]);
    const { dilateMask } = await import('../../../core/editing/engines/raster');
    const grown = dilateMask(mask, buf.width, buf.height, 3);
    await this.session.applyHeal(grown);
  });
}
```

- [ ] **Step 4: Add the erase UI hint**

In `tool-options.html`, add an `@case ('erase')` block with a short instruction (e.g. "Tap the thing you want gone — we select it and fill the space.") plus the shared `enginePct`/`healPct`/`engineError` status markup that the other engine tools use. Reuse the existing status partial pattern from the `select`/`bgremove` cases.

- [ ] **Step 5: Verify**

Build. If preview reachable: open Magic Erase, tap an object, confirm it is selected then inpainted in one action; screenshot. Otherwise report manual-verification-needed. Unit tests must stay green (`npm test`).

- [ ] **Step 6: Stage for review** (do NOT commit)

Run: `git add src/app/features/studio/`

---

## Phase 4 — ONNX engines (gated on model sourcing)

> Phases 1–3 ship without any new download. Phase 4 adds three ONNX tools (Denoise, AI Sharpen/Deblur, Colorize). Each engine module follows the existing `upscale-engine.ts` / `bokeh-engine.ts` pattern: a `MODEL_URL` constant, a lazily-created `getOrtSession`, a progress signal in `engine-status.ts`, and a `tool-options` `runEngine(...)` wrapper. The first step of the phase is verifying a commercial-safe pre-exported ONNX exists — do NOT hardcode an unverified URL.

### Task 9: Source + verify NAFNet and DDColor ONNX exports

**Files:** none yet (research + a short notes file).

- [ ] **Step 1: Find a commercial-safe ONNX export for each model**

For NAFNet (denoise + deblur, MIT) and DDColor (colorization, Apache-2.0), locate a pre-exported `.onnx` on a stable host (prefer HuggingFace `resolve/main/...` like the existing engines use). Record for each: exact URL, file size, input tensor name/shape/normalization, output tensor name/shape/range. Confirm the hosting repo's license does not add a non-commercial term on the weights.

- [ ] **Step 2: Confirm each URL actually loads**

Fetch each URL's headers to confirm it resolves and note `Content-Length` (drives the first-use download UX). If no commercial-safe pre-export exists, the fallback is to export from the permissive PyTorch weights with `optimum`/`torch.onnx` offline and host the result on a bucket the project controls — capture that as a follow-up task rather than blocking, and flag it to the user (it is outside the Angular app).

- [ ] **Step 3: Record findings**

Write the verified URLs + I/O specs + sizes into `docs/superpowers/plans/2026-07-11-phase4-model-notes.md` and add matching entries to the CLAUDE.md engine ledger (source, license, size). These values feed Tasks 10–13 (they are referenced as "the verified spec" below).

- [ ] **Step 4: Stage for review** (do NOT commit)

Run: `git add docs/superpowers/plans/2026-07-11-phase4-model-notes.md CLAUDE.md`
Then check in with the user before implementing the engines, since sizes/licenses affect the go/no-go.

---

### Task 10: Denoise + Deblur engine (NAFNet)

**Files:**
- Create: `src/app/core/editing/engines/denoise-engine.ts`
- Modify: `src/app/core/editing/engines/engine-status.ts`
- Test: `src/app/core/editing/engines/denoise-engine.spec.ts`

**Interfaces:**
- Consumes: `getOrtSession`, `toPlanarFloat`/`resizeBilinear` from `raster`, the verified NAFNet spec from Task 9.
- Produces: `denoiseModelProgress` signal; `async function restore(buf: PixelBuffer, variant: 'denoise' | 'deblur'): Promise<PixelBuffer>`.

- [ ] **Step 1: Add the progress signal**

In `engine-status.ts` add `export const denoiseModelProgress = signal<number | null>(null);` (mirror the existing signals + the header comment listing engines).

- [ ] **Step 2: Write a smoke test**

Create `denoise-engine.spec.ts` that imports the module and asserts the export shape without touching the network (mirror an existing engine spec — e.g. assert `typeof restore === 'function'` and that calling it in a non-OffscreenCanvas env is guarded). Keep it minimal; heavy inference isn't unit-tested (same as upscale/bokeh).

```ts
import { restore } from './denoise-engine';
describe('denoise-engine', () => {
  it('exports a restore function', () => {
    expect(typeof restore).toBe('function');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — module doesn't exist.

- [ ] **Step 4: Implement the engine**

Create `denoise-engine.ts` following `upscale-engine.ts` (tiled, SCALE=1, edge-pad to the model's required multiple; hot-swap GPU→wasm on non-finite output). Use two `MODEL_URL`s (denoise + deblur) from the verified spec, selected by `variant`. Normalize input per the verified spec; write the model output back into the tile core. Report progress via `denoiseModelProgress` (download) and reuse `upscaleTileProgress`-style local progress if you want a tile counter (add a `denoiseTileProgress` signal if so). Keep alpha via the same bilinear carry-over `upscale2x` uses.

(Complete code is templated on `upscale-engine.ts`; substitute SCALE=1, the two model URLs, and the verified normalization. Do not invent the URL — it comes from Task 9.)

- [ ] **Step 5: Run tests + build**

Run: `npm test` then the build. Expected: PASS + green (onnxruntime stays lazy — confirm the eager bundle size didn't jump; the module must only be `import()`-ed from `tool-options`).

- [ ] **Step 6: Stage for review** (do NOT commit)

Run: `git add src/app/core/editing/engines/denoise-engine.ts src/app/core/editing/engines/denoise-engine.spec.ts src/app/core/editing/engines/engine-status.ts`

---

### Task 11: Denoise + Deblur tools (ids, panel, wiring, low-res preview)

**Files:**
- Modify: `studio-tool.ts`, `studio-panel.ts`, `tool-options.ts` + `.html`

**Interfaces:**
- Consumes: `restore(buf, variant)` (Task 10), `denoiseModelProgress`, `EditSession.applyEngine`/`showPreviewBuffer`, `runEngine`.
- Produces: `StudioTool` gains `'denoise' | 'deblur'`; `ToolOptions.runDenoise()`, `runDeblur()`, and a low-res preview helper.

- [ ] **Step 1: Ids + panel**

Add `'denoise'` and `'deblur'` to `StudioTool` (not drag tools). In `studio-panel.ts` import icons (`lucideSparkle` / `lucideFocus` or nearest existing) and add to `PRO_TOOLS`: `{ id: 'denoise', label: 'Denoise', icon: 'lucideSparkle' }`, `{ id: 'deblur', label: 'AI Sharpen', icon: 'lucideFocus' }`.

- [ ] **Step 2: Engine wiring + low-res preview**

In `tool-options.ts`, add (mirroring `runUpscale`/`runBokehPreview`):

```ts
async runDenoise(): Promise<void> {
  await this.runEngine(async () => {
    const { restore } = await import('../../../core/editing/engines/denoise-engine');
    await this.session.applyEngine((buf) => restore(buf, 'denoise'));
  });
}

async runDeblur(): Promise<void> {
  await this.runEngine(async () => {
    const { restore } = await import('../../../core/editing/engines/denoise-engine');
    await this.session.applyEngine((buf) => restore(buf, 'deblur'));
  });
}
```

For instant feedback, add a downscaled preview that runs the engine on a ≤900px copy and shows it via `showPreviewBuffer` (reuse the bokeh preview token pattern to drop stale results). Trigger it when the tool opens (extend the tool-switch `effect`). Full-res runs on the Apply button.

Add `denoiseModelProgress` to the `enginePct` computed's `??` chain so its download % shows in the shared status UI.

- [ ] **Step 3: UI cases**

Add `@case ('denoise')` and `@case ('deblur')` blocks in `tool-options.html`: a short blurb, the shared engine status markup (`enginePct`/`engineBusy`/`engineError`), and an Apply button (`runDenoise()` / `runDeblur()`).

- [ ] **Step 4: Verify + stage**

Build + `npm test`. If preview reachable, exercise both tools on a noisy/blurry image and screenshot. Then `git add src/app/features/studio/`. Do NOT commit.

---

### Task 12: Colorize engine (DDColor)

**Files:**
- Create: `src/app/core/editing/engines/colorize-engine.ts`
- Modify: `engine-status.ts`
- Test: `src/app/core/editing/engines/colorize-engine.spec.ts`

**Interfaces:**
- Consumes: `getOrtSession`, `resizeBilinear`/`toPlanarFloat`/`resizeFloatMap` from `raster`, the verified DDColor spec from Task 9.
- Produces: `colorizeModelProgress` signal; `async function colorize(buf: PixelBuffer): Promise<PixelBuffer>`.

- [ ] **Step 1: Progress signal + smoke test**

Add `export const colorizeModelProgress = signal<number | null>(null);` to `engine-status.ts`. Create `colorize-engine.spec.ts` asserting `typeof colorize === 'function'` (network-free, like Task 10 Step 2).

- [ ] **Step 2: Run test — fails** (`npm test`, module missing).

- [ ] **Step 3: Implement**

Create `colorize-engine.ts` following `bokeh-engine.ts`'s fixed-size inference pattern: resize the input to the model's expected size (per verified spec), feed per the spec's normalization, take the colorized output, resize back to the source dimensions. To preserve full-res detail, keep the source luminance and take only chroma from the model output (convert both to YCbCr, swap Cb/Cr, convert back) — this avoids the softness of upscaling the model's small RGB output. Report download via `colorizeModelProgress`. Carry alpha through unchanged.

- [ ] **Step 4: Run tests + build** — PASS + green, onnxruntime stays lazy.

- [ ] **Step 5: Stage for review** (do NOT commit): `git add src/app/core/editing/engines/colorize-engine.ts src/app/core/editing/engines/colorize-engine.spec.ts src/app/core/editing/engines/engine-status.ts`

---

### Task 13: Colorize tool (id, panel, wiring)

**Files:** `studio-tool.ts`, `studio-panel.ts`, `tool-options.ts` + `.html`

**Interfaces:** Consumes `colorize` (Task 12), `colorizeModelProgress`. Produces `StudioTool` gains `'colorize'`; `ToolOptions.runColorize()`.

- [ ] **Step 1: Id + panel** — add `'colorize'` to `StudioTool`; import `lucidePaintbucket` (or nearest) and add `{ id: 'colorize', label: 'Colorize', icon: 'lucidePaintbucket' }` to `PRO_TOOLS`.

- [ ] **Step 2: Wiring**

```ts
async runColorize(): Promise<void> {
  await this.runEngine(async () => {
    const { colorize } = await import('../../../core/editing/engines/colorize-engine');
    await this.session.applyEngine(colorize);
  });
}
```

Add `colorizeModelProgress` to the `enginePct` `??` chain.

- [ ] **Step 3: UI case** — `@case ('colorize')` with a blurb ("Bring black-and-white photos to life."), shared engine status markup, and an Apply button calling `runColorize()`.

- [ ] **Step 4: Verify + stage** — build + `npm test`; if reachable, colorize a B&W image and screenshot. `git add src/app/features/studio/`. Do NOT commit.

---

## Phase 5 — Verify & report

### Task 14: Full verification pass

**Files:** none (verification only).

- [ ] **Step 1: Build** — run the build command; confirm "Application bundle generation complete" and that the initial bundle didn't balloon (onnxruntime + new engines must stay in lazy chunks, not the eager bundle). The pre-existing ~48 kB-over-budget warning is expected; a large jump is not.

- [ ] **Step 2: Tests** — run `npm test`; all specs green (new op/filter/engine specs + existing suite).

- [ ] **Step 3: Browser smoke (if reachable)** — via `preview_start`, walk every new surface: 17 filter chips incl. duotone pickers + clarity; Dehaze; Portrait Smooth; Magic Erase; Denoise; AI Sharpen; Colorize. Confirm live previews are smooth (no visible jank on a large image) and Apply commits + undo works. Capture screenshots. If the login gate blocks preview, report that in-app manual testing is required and list exactly what to check.

- [ ] **Step 4: Report to the user** — summarize what shipped, the confirmed licenses, any Phase-4 model-sourcing caveats, and the "Pro gate still open for testing" reminder. Do NOT commit — hand the staged changes to the user.

---

## Self-Review (completed during authoring)

- **Spec coverage:** Part 1 filters → Tasks 3–4 (all 10 spec presets incl. `clarity` via precomputed blurred-luminance map; `bleach` added as a bonus look, recorded back into the spec). Part 2 six Pro tools → Dehaze (5,7), Portrait Smooth (6,7), Magic Erase (8), Denoise (10,11), AI Sharpen/Deblur (10,11), Colorize (12,13). Part 3 perf → Tasks 1–2 (+ low-res ONNX preview in 11). License policy → Global Constraints + Task 9. No face-ML → enforced (Portrait Smooth is classical). All covered.
- **Placeholder scan:** ONNX `MODEL_URL`s are intentionally deferred to Task 9's verification rather than fabricated — this is a real dependency, not a placeholder, and Tasks 10/12 consume "the verified spec." Everything else has concrete code.
- **Type consistency:** worker op kinds (`dehaze`, `portraitSmooth`) match between `edit-worker.ts` registration and `tool-options` calls; `restore(buf, variant)` signature consistent across Tasks 10–11; `StudioTool` id spellings (`portraitsmooth`, `denoise`, `deblur`, `colorize`, `erase`, `dehaze`) consistent across studio-tool/panel/options.
