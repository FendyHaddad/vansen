import { signal } from '@angular/core';

/**
 * Heal-engine status, split from the engine module so UI can import it
 * without pulling onnxruntime into the eager bundle.
 */

/** 0..1 while the MI-GAN model downloads (first use only), null otherwise. */
export const healModelProgress = signal<number | null>(null);

/** True once the smart heal engine is initialized in this tab. */
export const healEngineReady = signal(false);
