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
    case 'adjust':
      return adjust(op.buffer, op.params);
    case 'sharpen':
      return sharpen(op.buffer, op.params);
    case 'smooth':
      return smooth(op.buffer, op.params);
    case 'crop':
      return crop(op.buffer, op.params);
    case 'rotate90':
      return rotate90(op.buffer);
    case 'liquify':
      return liquify(op.buffer, op.params);
  }
}

// Worker entrypoint — a window never exists inside a real Worker, so this
// block is inert when the module is imported for runOpSync.
if (
  typeof self !== 'undefined' &&
  typeof window === 'undefined' &&
  typeof (self as unknown as Worker).postMessage === 'function'
) {
  self.onmessage = (e: MessageEvent<WorkerOp>) => {
    const result = runOpSync(e.data);
    (self as unknown as Worker).postMessage(result, [result.data.buffer]);
  };
}
