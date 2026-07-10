/// <reference lib="webworker" />
import { PixelBuffer } from './pixel-buffer';
import { AdjustParams, adjust } from './ops/adjust';
import { CloneStep, cloneStamp } from './ops/clone';
import { sharpen, smooth } from './ops/convolve';
import { CropRect, crop, rotate90 } from './ops/crop';
import { enhance } from './ops/enhance';
import { FilterParams, filter } from './ops/filters';
import { heal } from './ops/heal';
import { LevelsParams, levels } from './ops/levels';
import { LiquifyStep, liquify } from './ops/liquify';
import { PerspectiveParams, perspective } from './ops/perspective';
import { RetouchStep, retouch } from './ops/retouch';
import { FlipAxis, StraightenParams, flip, rotate90ccw, straighten } from './ops/transform';

export type WorkerOp =
  | { kind: 'adjust'; buffer: PixelBuffer; params: AdjustParams }
  | { kind: 'sharpen'; buffer: PixelBuffer; params: number }
  | { kind: 'smooth'; buffer: PixelBuffer; params: number }
  | { kind: 'crop'; buffer: PixelBuffer; params: CropRect }
  | { kind: 'rotate90'; buffer: PixelBuffer; params: null }
  | { kind: 'rotate90ccw'; buffer: PixelBuffer; params: null }
  | { kind: 'flip'; buffer: PixelBuffer; params: FlipAxis }
  | { kind: 'straighten'; buffer: PixelBuffer; params: StraightenParams }
  | { kind: 'filter'; buffer: PixelBuffer; params: FilterParams }
  | { kind: 'enhance'; buffer: PixelBuffer; params: number }
  | { kind: 'levels'; buffer: PixelBuffer; params: LevelsParams }
  | { kind: 'clone'; buffer: PixelBuffer; params: CloneStep }
  | { kind: 'retouch'; buffer: PixelBuffer; params: RetouchStep }
  | { kind: 'perspective'; buffer: PixelBuffer; params: PerspectiveParams }
  | { kind: 'liquify'; buffer: PixelBuffer; params: LiquifyStep }
  | { kind: 'heal'; buffer: PixelBuffer; params: { mask: Uint8Array } };

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
    case 'rotate90ccw':
      return rotate90ccw(op.buffer);
    case 'flip':
      return flip(op.buffer, op.params);
    case 'straighten':
      return straighten(op.buffer, op.params);
    case 'filter':
      return filter(op.buffer, op.params);
    case 'enhance':
      return enhance(op.buffer, op.params);
    case 'levels':
      return levels(op.buffer, op.params);
    case 'clone':
      return cloneStamp(op.buffer, op.params);
    case 'retouch':
      return retouch(op.buffer, op.params);
    case 'perspective':
      return perspective(op.buffer, op.params);
    case 'liquify':
      return liquify(op.buffer, op.params);
    case 'heal':
      return heal(op.buffer, op.params.mask);
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
