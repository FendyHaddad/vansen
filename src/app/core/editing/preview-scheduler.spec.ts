import { describe, expect, it } from 'vitest';
import { PreviewScheduler } from './preview-scheduler';

describe('PreviewScheduler', () => {
  it('collapses many schedule() calls into one run per frame', () => {
    const rafQueue: FrameRequestCallback[] = [];
    const raf = (cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    };
    let runs = 0;
    const s = new PreviewScheduler(
      () => {
        runs++;
      },
      raf,
      () => {},
    );
    s.schedule();
    s.schedule();
    s.schedule();
    expect(runs).toBe(0); // nothing runs synchronously
    expect(rafQueue.length).toBe(1); // three schedules queue one frame
    rafQueue.shift()!(0);
    expect(runs).toBe(1);
  });

  it('cancel() prevents a pending run', () => {
    const rafQueue: FrameRequestCallback[] = [];
    const raf = (cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    };
    let runs = 0;
    const s = new PreviewScheduler(
      () => {
        runs++;
      },
      raf,
      () => {},
    );
    s.schedule();
    s.cancel();
    // caf is a no-op here, so the frame still fires — a cancelled run must
    // stay dead even when the host fails to cancel the callback.
    rafQueue.shift()?.(0);
    expect(runs).toBe(0);
  });

  it('can schedule again after the frame fires', async () => {
    const rafQueue: FrameRequestCallback[] = [];
    const raf = (cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    };
    let runs = 0;
    const s = new PreviewScheduler(
      () => {
        runs++;
      },
      raf,
      () => {},
    );
    s.schedule();
    rafQueue.shift()!(0);
    // A run is awaited now, even a synchronous one, so the second request
    // arrives while the first is still technically in flight and becomes its
    // replacement rather than a second concurrent run.
    s.schedule();
    await Promise.resolve();
    await Promise.resolve();
    rafQueue.shift()!(0);
    expect(runs).toBe(2);
  });
});

/**
 * R17: one frame per run is not the same as one run at a time.
 *
 * A slow preview (bokeh at full resolution is seconds) used to have every
 * subsequent frame start another one on top of it, so a slider drag queued
 * work the customer would never see and memory climbed for the duration.
 */
describe('PreviewScheduler concurrency', () => {
  it('keeps one active run and one latest replacement', async () => {
    const frames: FrameRequestCallback[] = [];
    let finish!: () => void;
    let value = 1;
    const seen: number[] = [];
    const scheduler = new PreviewScheduler(
      async () => {
        seen.push(value);
        if (seen.length === 1) {
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
        }
      },
      (cb) => frames.push(cb),
      () => {},
    );
    scheduler.schedule();
    frames.shift()!(0);
    for (value = 2; value <= 10; value++) {
      scheduler.schedule();
      frames.shift()?.(0);
    }
    expect(seen).toEqual([1]);
    value = 10;
    finish();
    await Promise.resolve();
    await Promise.resolve();
    frames.shift()?.(0);
    expect(seen).toEqual([1, 10]);
  });

  it('cancel drops the replacement instead of running it later', async () => {
    const frames: FrameRequestCallback[] = [];
    let finish!: () => void;
    let runs = 0;
    const scheduler = new PreviewScheduler(
      async () => {
        runs++;
        if (runs === 1) {
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
        }
      },
      (cb) => frames.push(cb),
      () => {},
    );
    scheduler.schedule();
    frames.shift()!(0);
    scheduler.schedule();
    frames.shift()?.(0);
    scheduler.cancel();

    finish();
    await Promise.resolve();
    await Promise.resolve();
    frames.shift()?.(0);
    expect(runs).toBe(1);
  });

  it('a run that throws still lets the next one start', async () => {
    const frames: FrameRequestCallback[] = [];
    let runs = 0;
    const scheduler = new PreviewScheduler(
      () => {
        runs++;
        return Promise.reject(new Error('preview failed'));
      },
      (cb) => frames.push(cb),
      () => {},
    );
    scheduler.schedule();
    frames.shift()!(0);
    await Promise.resolve();
    await Promise.resolve();

    scheduler.schedule();
    frames.shift()?.(0);
    await Promise.resolve();
    expect(runs).toBe(2);
  });
});
