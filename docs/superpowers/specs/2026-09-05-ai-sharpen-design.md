# AI Sharpen (NAFNet deblur) — design

Date: 2026-09-05. Status: shipped same day.

## Goal
Pro-tier, free, on-device deblur tool in the Studio rail. Complements the existing
`sharpen` unsharp-mask op with a real motion/lens deblur model.

## Model
- `opencv/deblurring_nafnet` → `deblurring_nafnet_2025may.onnx`, MIT (megvii-model),
  ~87.5 MiB quantized. Sourcing notes: `docs/superpowers/plans/2026-07-11-phase4-model-notes.md`.
- I/O: NCHW float32 RGB 0..1, dynamic H×W; output `[1,3,H,W]` 0..1 → ×255 clipped.
- GoPro deblur variant — not a denoiser. UI copy says "motion and lens blur".

## Engine — `src/app/core/editing/engines/deblur-engine.ts`
- `deblur(buf: PixelBuffer): Promise<PixelBuffer>`, same-size output.
- Tiled: 256 px core, 32 px context overlap, window edge-replicated to a multiple of 16
  (NAFNet = 4-level UNet). Only the core region is written back.
- Session via shared `getOrtSession` (Cache Storage `vansen-models`, WebGPU preferred).
  First tile validated with `saneTile`; on garbage output the session is re-created on
  `['wasm']` and the tile re-run (same pattern as `upscale-engine`).
- Alpha copied straight from source. `MAX_DEBLUR_PIXELS` = 16 MP → throws `'too_large'`.
- Progress: `deblurModelProgress` (download) + `deblurTileProgress` (inference) in
  `engine-status.ts`, so the UI never imports onnxruntime eagerly.

## UI
- `StudioTool` gains `'aisharpen'` (not a drag tool).
- `right-panel.ts` PRO_TOOLS: `{ id: 'aisharpen', label: 'Ai Sharpen', icon: 'lucideFocus' }`;
  pro perk copy lists AI Sharpen.
- `tool-options`: `@case ('aisharpen')` mirrors Upscale — hint, download %, tile %, error,
  too-large guard, "Sharpen with AI" button → `runAiSharpen()` → `session.applyEngine(deblur)`
  via lazy import. Generic too-large message now says "on-device processing".

## Testing
- No unit test for the engine (needs a live 88 MB model); `ng build` + existing 197 vitest
  cover the wiring. Manual smoke: open a blurry generation → Pro rail → Ai Sharpen.

## Out of scope
Denoise and Colorize — still blocked on offline ONNX export + self-hosting.
