import { signal } from '@angular/core';

/**
 * Engine-tool status signals, split from the engine modules so UI can import
 * them without pulling onnxruntime into the eager bundle. Each is 0..1 while
 * that model downloads (first use only), null otherwise.
 */

export const cutoutModelProgress = signal<number | null>(null);
export const depthModelProgress = signal<number | null>(null);
export const upscaleModelProgress = signal<number | null>(null);
export const samModelProgress = signal<number | null>(null);

/** 0..1 across upscale tiles while inference runs, null otherwise. */
export const upscaleTileProgress = signal<number | null>(null);

/** Largest input the on-device upscaler attempts — 16 MP in = 64 MP out;
 * tiling keeps inference memory flat, the output buffer is the ceiling.
 * Lives here (not in upscale-engine) so the UI can read it eagerly. */
export const MAX_UPSCALE_PIXELS = 4096 * 4096;
