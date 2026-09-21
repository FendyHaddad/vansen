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

  it('caps history by bytes, not by a step count', () => {
    // A step count is the wrong unit: twenty one-pixel edits cost nothing,
    // and twenty 4 MP edits cost 320 MB. These are one pixel each, so every
    // step fits and nothing is dropped.
    const e = new EditEngine(px(0));
    for (let i = 1; i <= 30; i++) e.push(px(i));
    let steps = 0;
    while (e.undo()) steps++;
    expect(steps).toBe(30);
    expect(e.historyTruncated).toBe(false);
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

/**
 * R17: twenty snapshots of a 4 MP image is 320 MB of history on a device that
 * may have a gigabyte to spend on the whole tab. The bound is bytes, not a
 * step count.
 */
describe('EditEngine memory bounds', () => {
  const pixel = (value: number): PixelBuffer => ({
    width: 1,
    height: 1,
    data: new Uint8ClampedArray([value, value, value, 255]),
  });

  /** A buffer of a chosen byte weight, tagged so it can be identified. */
  const block = (value: number, pixels: number): PixelBuffer => {
    const data = new Uint8ClampedArray(pixels * 4);
    data[0] = value;
    return { width: pixels, height: 1, data };
  };

  it('bounds past and redo history together while retaining current pixels', () => {
    const engine = new EditEngine(pixel(0), { maxHistoryBytes: 8 });
    for (let i = 1; i <= 25; i++) {
      engine.push(pixel(i));
      expect(engine.historyBytes).toBeLessThanOrEqual(8);
    }
    expect(engine.current.data[0]).toBe(25);
    expect(engine.undo()?.data[0]).toBe(24);
    expect(engine.undo()?.data[0]).toBe(23);
    expect(engine.undo()).toBeNull();
    expect(engine.historyBytes).toBeLessThanOrEqual(8);
    expect(engine.redo()?.data[0]).toBe(24);
    expect(engine.redo()?.data[0]).toBe(25);
  });

  it('the active image is never evicted, however large it is', () => {
    const engine = new EditEngine(pixel(0), { maxHistoryBytes: 8 });
    engine.push(block(7, 1000));
    expect(engine.current.data[0]).toBe(7);
    expect(engine.historyBytes).toBeLessThanOrEqual(8);
  });

  it('moving a large current image into redo does not blow the budget', () => {
    // 40 bytes of budget: the small steps fit, the big one cannot.
    const engine = new EditEngine(pixel(0), { maxHistoryBytes: 40 });
    engine.push(pixel(1));
    engine.push(block(2, 1000));
    engine.undo();

    expect(engine.current.data[0]).toBe(1);
    expect(engine.historyBytes).toBeLessThanOrEqual(40);
  });

  it('what remains is contiguous — the steps nearest now are the ones kept', () => {
    const engine = new EditEngine(pixel(0), { maxHistoryBytes: 12 });
    for (let i = 1; i <= 10; i++) engine.push(pixel(i));

    const walked: number[] = [];
    for (;;) {
      const prev = engine.undo();
      if (!prev) break;
      walked.push(prev.data[0]);
    }
    // Descending with no gaps: an eviction from the middle would show up here.
    expect(walked).toEqual([9, 8, 7]);
  });

  it('says out loud when older steps were dropped', () => {
    const engine = new EditEngine(pixel(0), { maxHistoryBytes: 8 });
    expect(engine.historyTruncated).toBe(false);
    for (let i = 1; i <= 10; i++) engine.push(pixel(i));
    expect(engine.historyTruncated).toBe(true);
  });

  it('a new edit clears redo and the bytes it accounted for', () => {
    const engine = new EditEngine(pixel(0), { maxHistoryBytes: 100 });
    engine.push(block(1, 10));
    engine.undo();
    const withRedo = engine.historyBytes;
    engine.push(pixel(2));

    expect(engine.canRedo).toBe(false);
    expect(engine.historyBytes).toBeLessThan(withRedo);
  });

  it('reset forgets every byte of history', () => {
    const engine = new EditEngine(pixel(0), { maxHistoryBytes: 100 });
    engine.push(pixel(1));
    engine.push(pixel(2));
    engine.reset(pixel(9));

    expect(engine.historyBytes).toBe(0);
    expect(engine.canUndo).toBe(false);
    expect(engine.historyTruncated).toBe(false);
  });
});
