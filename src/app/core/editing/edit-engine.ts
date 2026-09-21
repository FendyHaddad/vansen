import { PixelBuffer, clonePixels } from './pixel-buffer';

/**
 * How much of the customer's memory undo history may hold.
 *
 * The old bound was twenty steps. Twenty snapshots of a 4 MP image is 320 MB
 * on a device that may have a gigabyte for the whole tab, and the tab dies
 * without ever saying why.
 */
export const DEFAULT_MAX_HISTORY_BYTES = 192 * 1024 * 1024;

export interface EngineLimits {
  maxHistoryBytes: number;
}

function bytesOf(buffer: PixelBuffer): number {
  return buffer.data.byteLength;
}

/** Snapshot-based undo/redo over the working image, bounded by bytes. */
export class EditEngine {
  private past: PixelBuffer[] = [];
  private future: PixelBuffer[] = [];
  private present: PixelBuffer;
  private readonly maxHistoryBytes: number;
  private truncated = false;

  constructor(initial: PixelBuffer, limits?: EngineLimits) {
    this.present = clonePixels(initial);
    this.maxHistoryBytes = limits?.maxHistoryBytes ?? DEFAULT_MAX_HISTORY_BYTES;
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

  /**
   * Bytes held by undo and redo together. The active image is deliberately
   * outside this: it is what the customer is looking at, and dropping it to
   * stay under a history budget would be absurd.
   */
  get historyBytes(): number {
    return (
      this.past.reduce((sum, b) => sum + bytesOf(b), 0) +
      this.future.reduce((sum, b) => sum + bytesOf(b), 0)
    );
  }

  /** True once anything has been evicted — the UI can say undo is shorter. */
  get historyTruncated(): boolean {
    return this.truncated;
  }

  push(next: PixelBuffer): void {
    this.past.push(this.present);
    this.present = next;
    this.future = [];
    this.trim();
  }

  undo(): PixelBuffer | null {
    const prev = this.past.pop();
    if (!prev) return null;
    this.future.push(this.present);
    this.present = prev;
    this.trim();
    return this.present;
  }

  redo(): PixelBuffer | null {
    const next = this.future.pop();
    if (!next) return null;
    this.past.push(this.present);
    this.present = next;
    this.trim();
    return this.present;
  }

  reset(initial: PixelBuffer): void {
    this.past = [];
    this.future = [];
    this.truncated = false;
    this.present = clonePixels(initial);
  }

  /**
   * Drop the steps furthest from now until the budget is met.
   *
   * Furthest first keeps what remains contiguous: a gap in the middle would
   * let a customer undo past a state that no longer exists. The oldest undo
   * and the furthest redo are equally far away, so whichever end is longer
   * gives ground first.
   */
  private trim(): void {
    while (this.historyBytes > this.maxHistoryBytes) {
      const dropFromPast = this.past.length >= this.future.length;
      const dropped = dropFromPast ? this.past.shift() : this.future.shift();
      if (!dropped) return;
      this.truncated = true;
    }
  }
}
