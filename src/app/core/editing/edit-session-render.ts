import { signal } from '@angular/core';
import { EditEngine } from './edit-engine';
import { PixelBuffer } from './pixel-buffer';

/**
 * Encodes the committed pixels to a Blob URL for the `<img>` the viewport
 * overlays its live preview onto, plus the same encoding for export/
 * download. `renderSeq` drops an encode that resolves after a newer commit
 * already started its own — Blob encoding is async, so both can be in
 * flight at once and only the latest may win. Split out of `edit-session.ts`
 * — this only ever needs the engine passed in, never the session itself.
 */
export class ImagePreviewRenderer {
  private objectUrl = '';
  private renderSeq = 0;
  private readonly sig = signal('');

  readonly url = this.sig.asReadonly();

  /** Re-encode after a commit. No-op outside a browser (vitest). */
  refresh(engine: EditEngine | null): void {
    if (typeof OffscreenCanvas === 'undefined' || !engine) return; // vitest
    const seq = ++this.renderSeq;
    void bufferToBlob(engine.current).then((blob) => {
      if (seq !== this.renderSeq) return;
      this.revoke();
      this.objectUrl = URL.createObjectURL(blob);
      this.sig.set(this.objectUrl);
    });
  }

  /** Invalidate any in-flight refresh without touching the current URL —
   * called first on close so a late encode cannot resurrect a dead session. */
  invalidate(): void {
    this.renderSeq++;
  }

  /** Drop the current preview URL — the rest of a session close. */
  revoke(): void {
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = '';
    this.sig.set('');
  }
}

/** Encode pixels for download in the chosen format. */
export function exportBuffer(
  buf: PixelBuffer,
  type: 'image/png' | 'image/jpeg' | 'image/webp' = 'image/png',
  quality?: number,
): Promise<Blob> {
  return bufferToBlob(buf, type, quality);
}

function bufferToBlob(buf: PixelBuffer, type = 'image/png', quality?: number): Promise<Blob> {
  const canvas = new OffscreenCanvas(buf.width, buf.height);
  const ctx = canvas.getContext('2d')!;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(buf.data), buf.width, buf.height), 0, 0);
  if (type === 'image/jpeg') {
    // JPEG has no alpha and would flatten transparency (Cut Out) to black —
    // composite over white instead.
    const flat = new OffscreenCanvas(buf.width, buf.height);
    const fctx = flat.getContext('2d')!;
    fctx.fillStyle = '#fff';
    fctx.fillRect(0, 0, buf.width, buf.height);
    fctx.drawImage(canvas, 0, 0);
    return flat.convertToBlob({ type, quality });
  }
  return canvas.convertToBlob({ type, quality });
}
