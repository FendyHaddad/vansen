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

  it('can schedule again after the frame fires', () => {
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
    s.schedule();
    rafQueue.shift()!(0);
    expect(runs).toBe(2);
  });
});
