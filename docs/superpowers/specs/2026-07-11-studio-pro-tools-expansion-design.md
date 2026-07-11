# Studio & Pro Tools Expansion — Design

Date: 2026-07-11
Status: Approved (design), pending implementation plan

## Goal

Make Studio and Pro editing tools materially better along three axes:

1. **More Studio filters** — expand the one-look color filter set.
2. **6 new Pro tools** — all backed by free, commercial-use engines (open-source
   permissive licenses, or classical algorithms with no weights at all).
3. **Perf pass** — eliminate lag/jitter across local editing so slider drags and
   brush strokes stay smooth on large images.

Everything here is client-side (Canvas2D ops + lazy ONNX engines). No new backend,
no new paid provider calls. The existing infrastructure is reused:

- Pure-pixel ops live in `src/app/core/editing/ops/` and follow the `filters.ts`
  pattern (take a `PixelBuffer`, return a new one, alpha untouched).
- ONNX engines live in `src/app/core/editing/engines/`, loaded lazily through the
  shared `model-loader.ts` (download-once → Cache Storage `vansen-models` →
  WebGPU-then-wasm session). Progress signals live in `engine-status.ts`.
- Tools are registered in `studio-panel.ts` (`LOCAL_TOOLS`, `PRO_TOOLS`) and the
  active tool drives `canvas-viewport`.

## License policy (non-negotiable)

Only ship engines that are commercial-safe for **both code and weights**.

**Confirmed clean (verified license files):**

- NAFNet — MIT (denoise / deblur)
- SCUNet — Apache-2.0 (denoise) — backup option
- DDColor — Apache-2.0 (colorization), weights on HuggingFace `piddnad/DDColor-models`
- Existing engines already in use: SlimSAM (Apache), MI-GAN inpaint (MIT),
  Depth Anything V2 small (Apache), ISNet cutout (imgly, MIT), Swin2SR (Apache)

**Rejected — non-commercial weights (do NOT use):**

- GFPGAN — Apache "except third-party components"; bundles non-commercial
  StyleGAN2 / FFHQ pieces.
- CodeFormer — S-Lab non-commercial license.
- MODNet — code Apache, but pretrained weights are CC BY-NC.
- Face-parsing BiSeNet (zllrunning) — code MIT, but weights trained on
  CelebAMask-HQ (research-only dataset).
- Already banned in CLAUDE.md: RMBG (bria), AGPL ISNet mirror, Depth Anything B/L
  (non-commercial variants).

**Consequence:** no dedicated face-restoration ML. Portrait value is delivered with
a classical (weight-free) skin-smoothing op instead — 100% commercial-clean.

Every new ONNX model must have its source + license recorded in this repo's model
notes, and its `.onnx` origin URL captured (mirrored to a stable host we control if
the upstream is unreliable), same as existing engines.

## Part 1 — More Studio filters

Extend `ops/filters.ts` `FilterPreset` union and the `switch` with new looks.
Same signature, same intensity blend, same seeded grain RNG. No new files.

New presets (added to the existing bw / sepia / vintage / warm / cool / grain /
vignette):

- `fade` — lifted blacks, lowered contrast, slight desaturation.
- `noir` — high-contrast B&W with crushed blacks.
- `matte` — soft contrast curve, muted highlights.
- `tealorange` — cinematic teal shadows / orange skin split-tone.
- `goldenhour` — warm highlight glow, gentle bloom.
- `crossprocess` — S-curve per channel, green shadows / yellow highlights.
- `infrared` — channel-swap false-color look.
- `bleach` — bleach-bypass: gray overlay blend, gritty desaturated contrast.
- `duotone` — map luminance between two tint colors (params: two colors).
- `clarity` — local-contrast "pop" (unsharp on blurred luminance, mild;
  needs a precomputed blurred-luminance map before the per-pixel loop).

`duotone` needs two color params; extend `FilterParams` with optional
`colorA` / `colorB` (only read for that preset). The filters tool UI in
`tool-options` gains the new preset chips; `duotone` reveals two swatches.

Cost: pure pixel math, negligible. Covered by the Part 3 perf plan (preview proxy).

## Part 2 — 6 new Pro tools

All commercial-safe. 3 new ONNX engines + 3 built on existing infra / classical.

### New ONNX engines (new files in `engines/`)

1. **Denoise** — NAFNet (MIT). New engine `denoise-engine.ts`, progress signal in
   `engine-status.ts`. Tiled like upscale to bound memory. WebGPU→wasm.
2. **AI Sharpen / Deblur** — NAFNet deblur variant (MIT). Same runtime family as
   denoise; may share a loader/engine module with a model-id switch. Tiled.
3. **Colorize** — DDColor (Apache). New engine `colorize-engine.ts`. Runs on the
   luminance of a B&W (or any) image, returns chroma. Fixed inference size with
   up/down resample; progress signal.

### Built on existing infra / classical (no new weights)

4. **Magic Erase** — tap an object → SlimSAM mask (existing `select-engine`) →
   MI-GAN inpaint (existing `heal-engine`). New orchestration only; no new model.
   Distinct from Ai Select in that it is one-tap "remove this thing" with auto
   mask-grow + feather.
5. **Portrait Smooth** — classical frequency-separation skin smoothing
   (`ops/portrait-smooth.ts`): split low/high frequency via blur, smooth the low
   band, recombine, protect edges. Optional strength + a "skin only" limiter using
   a simple skin-tone mask (or an existing SAM mask if the user selected). No ML
   weights.
6. **Dehaze** — classical dark-channel-prior dehazing (`ops/dehaze.ts`): estimate
   atmospheric light + transmission map, restore contrast/color. Strength slider.
   No ML weights. Great on fog / haze / underwater shots.

### Registration

Add all six to `PRO_TOOLS` in `studio-panel.ts` with Lucide icons; wire tool
options (sliders) in `tool-options`; wire the active-tool → viewport path. Pro
tools stay unlocked-while-testing (`proLocked = signal(false)`) per current policy;
do NOT wire the real Pro gate until the user says these passed testing.

## Part 3 — Perf pass (full)

**Root cause of jitter:** local pixel ops run on the main thread at full resolution
on every slider tick, allocating a fresh buffer each time. Large images → dropped
frames while dragging.

Four changes, applied across all local tools (existing + new):

1. **Downscaled live-preview proxy.** While a slider/brush is active, compute the
   effect on a small proxy (longest edge ~1024px), paint that scaled up. Run the
   full-resolution op once on Apply/commit. Perspective already does this
   (`canvas-viewport` downscaled preview) — generalize into a shared preview helper
   the session/viewport can call for any op.
2. **Worker offload.** Route heavy ops through the existing `edit-worker`
   (OffscreenCanvas) so the main thread never blocks on a full-res compute. Ops must
   be pure `(PixelBuffer, params) → PixelBuffer` (they already are), so they can run
   in-worker unchanged. Fallback path stays for no-worker environments.
3. **rAF-coalesced input.** Collapse rapid slider `input` events to one compute per
   animation frame (requestAnimationFrame), dropping stale intermediate frames.
   Reuse a scratch buffer instead of allocating per tick.
4. **ONNX preview pass.** For bokeh / denoise / colorize / deblur, run a low-res
   preview first for instant feedback, then the full pass on commit. WebGPU is
   already preferred in `model-loader`.

**Interfaces introduced:**

- A small `preview-proxy` helper (shared): given a source buffer + an op fn + params,
  returns a downscaled result for live paint, and a `commit()` for full-res.
- Worker message contract extended to carry any op id + params (today it handles a
  subset). Op registry maps op-id → pure fn on both main and worker sides so there is
  one source of truth.

**Non-goals:** WebGPU compute shaders for filters (overkill), rewriting the ONNX
runtime, GPU-side tiling changes.

## Testing

- `ops.spec.ts` extended: each new filter preset and each new classical op
  (portrait-smooth, dehaze) gets a deterministic pixel-level test (seeded, small
  fixed input → known output invariants: alpha untouched, intensity=0 is identity,
  bounds clamped 0..255).
- Engine modules: smoke tests that the loader/session wiring resolves and the
  pre/post tensor shaping is correct (mock the ort session where practical, mirror
  existing engine specs).
- Perf: a test that the preview proxy path produces a buffer no larger than the
  proxy cap, and that rAF coalescing collapses N synchronous updates into one
  compute (spy on the op fn call count).
- Full build must stay green: `npx ng build` (nvm 22.23.1). Run `npm test` for
  TestBed/vitest specs (bare `npx vitest run` falsely fails TestBed).

## Rollout order (for the implementation plan)

1. Perf foundation first (preview-proxy helper + op registry + worker contract +
   rAF coalescing) — everything else rides on it and it de-risks the new tools.
2. Filters expansion (cheap, validates the preview path end-to-end).
3. Classical Pro ops (Portrait Smooth, Dehaze) + Magic Erase orchestration.
4. New ONNX engines (Denoise, Deblur, Colorize) — heaviest, last.
5. Verify: build + tests + manual preview report for user testing.

## Open items to resolve during implementation

- Exact NAFNet + DDColor `.onnx` export sources and sizes (find/confirm a
  commercial-safe pre-exported ONNX, or export from the permissive weights). Record
  size so first-use download UX matches existing engines.
- Where the model-license notes live (extend the CLAUDE.md engine ledger).
- Whether Denoise + Deblur share one engine module (model-id switch) or two.
