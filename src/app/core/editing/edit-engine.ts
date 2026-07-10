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
