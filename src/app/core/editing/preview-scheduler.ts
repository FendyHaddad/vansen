/**
 * Coalesces bursty preview requests (slider drags) into one run per animation
 * frame, dropping stale intermediate frames. raf/caf are injectable for tests.
 */
export class PreviewScheduler {
  private handle: number | null = null;
  /** Bumped on cancel so an already-queued frame knows it went stale. */
  private gen = 0;

  constructor(
    private readonly run: () => void | Promise<void>,
    private readonly raf: (cb: FrameRequestCallback) => number = (cb) => requestAnimationFrame(cb),
    private readonly caf: (h: number) => void = (h) => cancelAnimationFrame(h),
  ) {}

  schedule(): void {
    if (this.handle !== null) return; // a frame is already queued — coalesce
    const gen = this.gen;
    this.handle = this.raf(() => {
      this.handle = null;
      if (gen !== this.gen) return; // cancelled while queued
      void this.run();
    });
  }

  cancel(): void {
    this.gen++;
    if (this.handle !== null) {
      this.caf(this.handle);
      this.handle = null;
    }
  }
}
