/**
 * Coalesces bursty preview requests (slider drags) into one run per animation
 * frame, and — separately — keeps at most one run in flight at a time.
 *
 * One run per frame is not the same as one run at a time. A bokeh preview
 * takes seconds; under the frame-only rule every later frame started another
 * one on top of it, so a slider drag piled up work nobody would ever see and
 * memory climbed for as long as the drag lasted. Now a request that arrives
 * during a run becomes *the* replacement, overwriting any earlier one.
 *
 * raf/caf are injectable for tests.
 */
export class PreviewScheduler {
  private handle: number | null = null;
  /** Bumped on cancel so an already-queued frame or run knows it went stale. */
  private gen = 0;
  private active = false;
  private pending = false;

  constructor(
    private readonly run: () => void | Promise<void>,
    private readonly raf: (cb: FrameRequestCallback) => number = (cb) => requestAnimationFrame(cb),
    private readonly caf: (h: number) => void = (h) => cancelAnimationFrame(h),
  ) {}

  schedule(): void {
    // Something is running: remember that a newer state wants a preview, and
    // let the run that is finishing start it. Recording "yes, again" rather
    // than a queue is what keeps this bounded.
    if (this.active) {
      this.pending = true;
      return;
    }
    if (this.handle !== null) return; // a frame is already queued — coalesce
    const gen = this.gen;
    this.handle = this.raf(() => {
      this.handle = null;
      if (gen !== this.gen) return; // cancelled while queued
      void this.start(gen);
    });
  }

  cancel(): void {
    this.gen++;
    this.pending = false;
    if (this.handle === null) return;
    this.caf(this.handle);
    this.handle = null;
  }

  private async start(gen: number): Promise<void> {
    this.active = true;
    try {
      await this.run();
    } catch {
      // A failed preview is not fatal — the next one gets a clean start.
    } finally {
      this.active = false;
    }
    // Cancelled while it ran: whatever was asked for no longer applies.
    if (gen !== this.gen) return;
    if (!this.pending) return;
    this.pending = false;
    this.schedule();
  }
}
