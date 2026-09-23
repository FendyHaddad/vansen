import { signal } from '@angular/core';
import { clamp } from './viewport-math';

/**
 * Click-drag pan state for the zoomed-in canvas viewport, moved out of
 * CanvasViewport verbatim. Zoom itself stays on EditSession — this only
 * tracks the CSS-pixel pan offset and the in-flight drag gesture.
 */
export class ViewportPanZoom {
  readonly pan = signal({ x: 0, y: 0 });
  private readonly drag = signal<{
    startX: number;
    startY: number;
    origin: { x: number; y: number };
  } | null>(null);

  isDragging(): boolean {
    return this.drag() !== null;
  }

  startDrag(clientX: number, clientY: number): void {
    this.drag.set({ startX: clientX, startY: clientY, origin: this.pan() });
  }

  updateDrag(clientX: number, clientY: number): void {
    const d = this.drag();
    if (!d) return;
    this.pan.set({ x: d.origin.x + clientX - d.startX, y: d.origin.y + clientY - d.startY });
  }

  endDrag(): void {
    this.drag.set(null);
  }

  /** Trackpad/wheel pan while zoomed in. */
  panBy(deltaX: number, deltaY: number): void {
    this.pan.update((p) => ({ x: p.x - deltaX, y: p.y - deltaY }));
  }

  /** The image is centered; panning may shift it at most until the far edge
   * reaches the viewport edge (no gap can open on the opposite side). */
  clamp(imgWidth: number, imgHeight: number, vpWidth: number, vpHeight: number): void {
    const maxX = Math.max(0, (imgWidth - vpWidth) / 2);
    const maxY = Math.max(0, (imgHeight - vpHeight) / 2);
    this.pan.update((p) => {
      const x = clamp(p.x, -maxX, maxX);
      const y = clamp(p.y, -maxY, maxY);
      return x === p.x && y === p.y ? p : { x, y };
    });
  }

  reset(): void {
    this.pan.set({ x: 0, y: 0 });
  }
}
