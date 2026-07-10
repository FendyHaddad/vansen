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

  it('caps history at 20 snapshots', () => {
    const e = new EditEngine(px(0));
    for (let i = 1; i <= 30; i++) e.push(px(i));
    let steps = 0;
    while (e.undo()) steps++;
    expect(steps).toBeLessThanOrEqual(20);
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
