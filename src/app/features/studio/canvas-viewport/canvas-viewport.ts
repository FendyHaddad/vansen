import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { EditSession } from '../../../core/editing/edit-session';
import { CropRect } from '../../../core/editing/ops/crop';
import { MaskCanvas } from '../mask-canvas/mask-canvas';
import { StudioTool } from '../studio-tool';

/** Center stage in edit mode: the working image + paintable mask overlay. */
@Component({
  selector: 'app-canvas-viewport',
  templateUrl: './canvas-viewport.html',
  styleUrl: './canvas-viewport.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MaskCanvas],
})
export class CanvasViewport {
  readonly session = inject(EditSession);
  readonly maskCanvas = viewChild(MaskCanvas);

  readonly tool = input<StudioTool | null>(null);
  readonly brushSize = input(40);

  /** Crop drag rectangle in image pixels, null = none. */
  readonly cropRect = signal<CropRect | null>(null);

  readonly cropPct = computed(() => {
    const r = this.cropRect();
    const b = this.session.current();
    if (!r || !b) return { left: 0, top: 0, width: 0, height: 0 };
    return {
      left: (r.x / b.width) * 100,
      top: (r.y / b.height) * 100,
      width: (r.width / b.width) * 100,
      height: (r.height / b.height) * 100,
    };
  });

  private dragStart: { x: number; y: number } | null = null;
  private healStroke: { x: number; y: number }[] = [];
  private liquifyLast: { x: number; y: number } | null = null;

  /** Screen point → image-pixel point using the preview img's displayed size. */
  private toImagePoint(e: PointerEvent): { x: number; y: number } | null {
    const img = (e.currentTarget as HTMLElement).querySelector('img');
    const buf = this.session.current();
    if (!img || !buf) return null;
    const r = img.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return {
      x: ((e.clientX - r.x) / r.width) * buf.width,
      y: ((e.clientY - r.y) / r.height) * buf.height,
    };
  }

  onPointerDown(e: PointerEvent): void {
    const p = this.toImagePoint(e);
    if (!p) return;
    const t = this.tool();
    if (t === 'crop') this.dragStart = p;
    if (t === 'heal') this.healStroke = [p];
    if (t === 'liquify') this.liquifyLast = p;
  }

  onPointerMove(e: PointerEvent): void {
    const p = this.toImagePoint(e);
    if (!p) return;
    const t = this.tool();
    if (t === 'crop' && this.dragStart) {
      this.cropRect.set({
        x: Math.min(this.dragStart.x, p.x),
        y: Math.min(this.dragStart.y, p.y),
        width: Math.abs(p.x - this.dragStart.x),
        height: Math.abs(p.y - this.dragStart.y),
      });
    }
    if (t === 'heal' && this.healStroke.length) this.healStroke.push(p);
    if (t === 'liquify' && this.liquifyLast && !this.session.busy()) {
      const step = {
        cx: this.liquifyLast.x,
        cy: this.liquifyLast.y,
        radius: this.brushSize(),
        dx: p.x - this.liquifyLast.x,
        dy: p.y - this.liquifyLast.y,
      };
      this.liquifyLast = p;
      void this.session.apply('liquify', step);
    }
  }

  async onPointerUp(): Promise<void> {
    const t = this.tool();
    if (t === 'heal' && this.healStroke.length) {
      const buf = this.session.current();
      if (buf) {
        const mask = new Uint8Array(buf.width * buf.height);
        for (const pt of this.healStroke) {
          stampCircle(mask, buf.width, buf.height, pt, this.brushSize());
        }
        this.healStroke = [];
        await this.session.applyHeal(mask);
      }
    }
    this.healStroke = [];
    this.dragStart = null;
    this.liquifyLast = null;
  }

  async applyCrop(): Promise<void> {
    const r = this.cropRect();
    if (!r || r.width < 4 || r.height < 4) return;
    await this.session.apply('crop', r);
    this.cropRect.set(null);
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
