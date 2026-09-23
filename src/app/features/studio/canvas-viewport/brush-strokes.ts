import { EditSession } from '../../../core/editing/edit-session';
import { LiquifyMode } from '../../../core/editing/ops/liquify';
import { RetouchMode } from '../../../core/editing/ops/retouch';

/**
 * Pointer-drag bookkeeping for the four brush tools (heal, liquify, clone,
 * retouch), moved out of CanvasViewport verbatim. The component still owns
 * the pointer event wiring and the tool-specific input signals (brush size,
 * strengths, ...) and passes their values in at each call; this class only
 * tracks in-flight stroke state and talks to EditSession.
 */
export class BrushStrokes {
  constructor(private readonly session: EditSession) {}

  private healStroke: { x: number; y: number }[] = [];
  private liquifyLast: { x: number; y: number } | null = null;
  private liquifyStroked = false;
  private liquifyPending = 0;
  /** Fixed source − stroke-start offset while a clone drag is active. */
  private cloneOffset: { x: number; y: number } | null = null;
  private cloneLast: { x: number; y: number } | null = null;
  private cloneStroked = false;
  private clonePending = 0;
  private retouchLast: { x: number; y: number } | null = null;
  private retouchStroked = false;
  private retouchPending = 0;

  get healActive(): boolean {
    return this.healStroke.length > 0;
  }
  get liquifyDragging(): boolean {
    return this.liquifyLast !== null;
  }
  get liquifyStrokedFlag(): boolean {
    return this.liquifyStroked;
  }
  get cloneStrokeDragging(): boolean {
    return this.cloneLast !== null;
  }
  get cloneStrokedFlag(): boolean {
    return this.cloneStroked;
  }
  get retouchDragging(): boolean {
    return this.retouchLast !== null;
  }
  get retouchStrokedFlag(): boolean {
    return this.retouchStroked;
  }

  // --- heal ---------------------------------------------------------------

  beginHeal(p: { x: number; y: number }): void {
    this.healStroke = [p];
  }

  dragHeal(p: { x: number; y: number }): void {
    if (!this.healStroke.length) return;
    this.healStroke.push(p);
  }

  async commitHeal(radius: number): Promise<void> {
    const buf = this.session.current();
    if (!buf) return;
    const mask = new Uint8Array(buf.width * buf.height);
    for (const pt of this.healStroke) stampCircle(mask, buf.width, buf.height, pt, radius);
    this.healStroke = [];
    await this.session.applyHeal(mask);
  }

  // --- liquify --------------------------------------------------------------

  beginLiquify(p: { x: number; y: number }, mode: LiquifyMode, radius: number, strength: number): void {
    this.liquifyLast = p;
    // Pinch/bulge act on click too — no drag needed to see the effect.
    if (mode !== 'push') {
      this.postLiquifyStep({ cx: p.x, cy: p.y, dx: 0, dy: 0 }, radius, mode, strength);
    }
  }

  dragLiquify(p: { x: number; y: number }, radius: number, mode: LiquifyMode, strength: number): void {
    if (!this.liquifyLast) return;
    // Backpressure: if the worker is behind, let displacement accumulate
    // into the next event instead of queueing an ever-growing backlog.
    if (this.liquifyPending > 2) return;
    const dx = p.x - this.liquifyLast.x;
    const dy = p.y - this.liquifyLast.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) return;
    // Split fast pointer jumps into capped sub-steps along the segment —
    // one violent step was the "jitter"; several gentle ones read smooth.
    const maxStep = radius * 0.35;
    const n = Math.min(4, Math.max(1, Math.ceil(len / maxStep)));
    const sx = dx / n;
    const sy = dy / n;
    const sLen = Math.hypot(sx, sy);
    const k = sLen > maxStep ? maxStep / sLen : 1;
    for (let i = 0; i < n; i++) {
      this.postLiquifyStep(
        { cx: this.liquifyLast.x + sx * i, cy: this.liquifyLast.y + sy * i, dx: sx * k, dy: sy * k },
        radius,
        mode,
        strength,
      );
    }
    this.liquifyLast = p;
  }

  /** Preview-only liquify step: instant feedback, one undo entry per stroke. */
  private postLiquifyStep(
    step: { cx: number; cy: number; dx: number; dy: number },
    radius: number,
    mode: LiquifyMode,
    strength: number,
  ): void {
    this.liquifyStroked = true;
    this.liquifyPending++;
    void this.session
      .strokeOp('liquify', { ...step, radius, mode, strength: strength / 100 })
      .finally(() => this.liquifyPending--);
  }

  async commitLiquify(): Promise<void> {
    this.liquifyStroked = false;
    this.liquifyLast = null;
    await this.session.commitStroke();
  }

  // --- clone ---------------------------------------------------------------

  beginClone(src: { x: number; y: number }, p: { x: number; y: number }, radius: number, strength: number): void {
    this.cloneOffset = { x: src.x - p.x, y: src.y - p.y };
    this.cloneLast = p;
    this.postCloneStamp(p, radius, strength);
  }

  dragClone(p: { x: number; y: number }, radius: number, strength: number): void {
    if (!this.cloneLast) return;
    if (this.clonePending > 2) return;
    stampAlong(this.cloneLast, p, radius * 0.35, (q) => this.postCloneStamp(q, radius, strength));
    this.cloneLast = p;
  }

  private postCloneStamp(q: { x: number; y: number }, radius: number, strength: number): void {
    const off = this.cloneOffset;
    if (!off) return;
    this.cloneStroked = true;
    this.clonePending++;
    void this.session
      .strokeOp('clone', {
        sx: q.x + off.x,
        sy: q.y + off.y,
        tx: q.x,
        ty: q.y,
        radius,
        strength: strength / 100,
      })
      .finally(() => this.clonePending--);
  }

  async commitClone(): Promise<void> {
    this.cloneStroked = false;
    this.cloneOffset = null;
    this.cloneLast = null;
    await this.session.commitStroke();
  }

  // --- retouch ---------------------------------------------------------------

  beginRetouch(
    p: { x: number; y: number },
    radius: number,
    mode: RetouchMode,
    strength: number,
    feather: number,
  ): void {
    this.retouchLast = p;
    this.postRetouchDab(p, radius, mode, strength, feather);
  }

  dragRetouch(
    p: { x: number; y: number },
    radius: number,
    mode: RetouchMode,
    strength: number,
    feather: number,
  ): void {
    if (!this.retouchLast) return;
    if (this.retouchPending > 2) return;
    stampAlong(this.retouchLast, p, radius * 0.4, (q) => this.postRetouchDab(q, radius, mode, strength, feather));
    this.retouchLast = p;
  }

  private postRetouchDab(
    q: { x: number; y: number },
    radius: number,
    mode: RetouchMode,
    strength: number,
    feather: number,
  ): void {
    this.retouchStroked = true;
    this.retouchPending++;
    void this.session
      .strokeOp('retouch', {
        cx: q.x,
        cy: q.y,
        radius,
        mode,
        // Half-scaled per dab so a slow pass builds up instead of slamming.
        strength: (strength / 100) * 0.5,
        feather: feather / 100,
      })
      .finally(() => this.retouchPending--);
  }

  async commitRetouch(): Promise<void> {
    this.retouchStroked = false;
    this.retouchLast = null;
    await this.session.commitStroke();
  }

  /** Unconditional reset — called once per pointer-up regardless of which
   * tool (if any) was actually dragging. */
  resetAll(): void {
    this.healStroke = [];
    this.liquifyLast = null;
    this.cloneOffset = null;
    this.cloneLast = null;
    this.retouchLast = null;
  }
}

/** Evenly spaced dabs from a (exclusive) to b (inclusive), capped per event. */
function stampAlong(
  a: { x: number; y: number },
  b: { x: number; y: number },
  spacing: number,
  dab: (q: { x: number; y: number }) => void,
): void {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len === 0) return;
  const n = Math.min(6, Math.max(1, Math.round(len / Math.max(2, spacing))));
  for (let i = 1; i <= n; i++) {
    dab({ x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n });
  }
}

function stampCircle(
  mask: Uint8Array,
  w: number,
  h: number,
  p: { x: number; y: number },
  radius: number,
): void {
  const r2 = radius * radius;
  const x0 = Math.max(0, Math.floor(p.x - radius));
  const x1 = Math.min(w - 1, Math.ceil(p.x + radius));
  const y0 = Math.max(0, Math.floor(p.y - radius));
  const y1 = Math.min(h - 1, Math.ceil(p.y + radius));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if ((x - p.x) ** 2 + (y - p.y) ** 2 <= r2) mask[y * w + x] = 255;
    }
  }
}
