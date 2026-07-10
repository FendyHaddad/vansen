import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  effect,
  input,
  signal,
  viewChild,
} from '@angular/core';

/**
 * Image with a paintable mask layer. The mask is drawn on a <canvas> stacked over
 * the <img>; export produces a base64 PNG at the image's natural size (the format
 * GPT Image's edits endpoint expects).
 */
@Component({
  selector: 'app-mask-canvas',
  templateUrl: './mask-canvas.html',
  styleUrl: './mask-canvas.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MaskCanvas implements AfterViewInit, OnDestroy {
  readonly imageUrl = input.required<string>();
  readonly enabled = input(false);

  readonly brushSize = signal(40);
  readonly tool = signal<'brush' | 'eraser'>('brush');

  private readonly img = viewChild.required<ElementRef<HTMLImageElement>>('img');
  private readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');

  private resizeObserver: ResizeObserver | null = null;
  private drawing = false;
  private last: { x: number; y: number } | null = null;
  private readonly dirty = signal(false);

  constructor() {
    // Clear the mask whenever the source image changes
    effect(() => {
      this.imageUrl();
      this.clear();
    });
  }

  ngAfterViewInit(): void {
    const imgEl = this.img().nativeElement;
    this.resizeObserver = new ResizeObserver(() => this.syncCanvasSize());
    this.resizeObserver.observe(imgEl);
    this.syncCanvasSize();
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
  }

  hasMask(): boolean {
    return this.dirty();
  }

  clear(): void {
    const canvasEl = this.canvas?.()?.nativeElement;
    if (!canvasEl) return;
    const ctx = canvasEl.getContext('2d');
    ctx?.clearRect(0, 0, canvasEl.width, canvasEl.height);
    this.dirty.set(false);
  }

  /** Base64 PNG at the image's natural resolution, or null when no mask painted. */
  exportMaskPng(): string | null {
    if (!this.dirty()) return null;
    const imgEl = this.img().nativeElement;
    const canvasEl = this.canvas().nativeElement;
    const out = document.createElement('canvas');
    out.width = imgEl.naturalWidth || canvasEl.width;
    out.height = imgEl.naturalHeight || canvasEl.height;
    const ctx = out.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(canvasEl, 0, 0, out.width, out.height);
    return out.toDataURL('image/png');
  }

  onPointerDown(event: PointerEvent): void {
    if (!this.enabled() || event.button !== 0) return;
    this.drawing = true;
    this.last = this.pointFrom(event);
    this.paint(this.last, this.last);
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
  }

  onPointerMove(event: PointerEvent): void {
    if (!this.drawing || !this.enabled()) return;
    const point = this.pointFrom(event);
    if (this.last) this.paint(this.last, point);
    this.last = point;
  }

  onPointerUp(): void {
    this.drawing = false;
    this.last = null;
  }

  private pointFrom(event: PointerEvent): { x: number; y: number } {
    const canvasEl = this.canvas().nativeElement;
    const rect = canvasEl.getBoundingClientRect();
    // Screen → backing-store px: the canvas may be CSS-scaled (viewport zoom).
    const sx = rect.width ? canvasEl.width / rect.width : 1;
    const sy = rect.height ? canvasEl.height / rect.height : 1;
    return { x: (event.clientX - rect.x) * sx, y: (event.clientY - rect.y) * sy };
  }

  private paint(from: { x: number; y: number }, to: { x: number; y: number }): void {
    const ctx = this.canvas().nativeElement.getContext('2d');
    if (!ctx) return;
    ctx.globalCompositeOperation =
      this.tool() === 'brush' ? 'source-over' : 'destination-out';
    ctx.strokeStyle = 'rgba(130, 90, 255, 0.55)';
    ctx.fillStyle = 'rgba(130, 90, 255, 0.55)';
    ctx.lineWidth = this.brushSize();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    this.dirty.set(true);
  }

  private syncCanvasSize(): void {
    const imgEl = this.img().nativeElement;
    const canvasEl = this.canvas().nativeElement;
    const { width, height } = imgEl.getBoundingClientRect();
    if (width === 0 || height === 0) return;
    if (canvasEl.width !== Math.round(width) || canvasEl.height !== Math.round(height)) {
      canvasEl.width = Math.round(width);
      canvasEl.height = Math.round(height);
      this.dirty.set(false);
    }
  }
}
