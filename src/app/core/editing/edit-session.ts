import { Injectable, computed, signal } from '@angular/core';
import { GenerationDto } from '../api/dtos';
import { EditEngine } from './edit-engine';
import { PixelBuffer } from './pixel-buffer';
import { WorkerOp, runOpSync } from './edit-worker';
import { heal } from './ops/heal';

/**
 * One editing session over a library image: working pixels, history, dirty
 * state. Heavy ops go to a Worker when the platform has one; vitest and
 * fallback paths run synchronously — identical output either way.
 */
@Injectable({ providedIn: 'root' })
export class EditSession {
  private engine: EditEngine | null = null;
  private worker: Worker | null = null;
  private objectUrl = '';

  private readonly itemSig = signal<GenerationDto | null>(null);
  private readonly dirtySig = signal(false);
  private readonly busySig = signal(false);
  private readonly previewSig = signal('');
  private readonly historyTick = signal(0);

  readonly item = this.itemSig.asReadonly();
  readonly dirty = this.dirtySig.asReadonly();
  readonly busy = this.busySig.asReadonly();
  readonly previewUrl = this.previewSig.asReadonly();
  readonly canUndo = computed(() => {
    this.historyTick();
    return this.engine?.canUndo ?? false;
  });
  readonly canRedo = computed(() => {
    this.historyTick();
    return this.engine?.canRedo ?? false;
  });

  /** Browser entry: decode the media into pixels, then start the session. */
  async open(item: GenerationDto): Promise<void> {
    this.busySig.set(true);
    try {
      const res = await fetch(item.mediaUrl);
      const bitmap = await createImageBitmap(await res.blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      const img = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      this.openWithBuffer(item, { width: img.width, height: img.height, data: img.data });
    } finally {
      this.busySig.set(false);
    }
  }

  /** Test seam + shared init. */
  openWithBuffer(item: GenerationDto, buf: PixelBuffer): void {
    this.engine = new EditEngine(buf);
    this.itemSig.set(item);
    this.dirtySig.set(false);
    this.historyTick.update((n) => n + 1);
    this.refreshPreview();
  }

  /** After a save: keep editing the same pixels under the new version's identity. */
  adoptItem(saved: GenerationDto): void {
    this.itemSig.set(saved);
    this.dirtySig.set(false);
  }

  close(): void {
    this.engine = null;
    this.itemSig.set(null);
    this.dirtySig.set(false);
    this.historyTick.update((n) => n + 1);
    this.revokePreview();
    this.worker?.terminate();
    this.worker = null;
  }

  async apply(kind: WorkerOp['kind'], params: unknown): Promise<void> {
    if (!this.engine) return;
    this.busySig.set(true);
    try {
      const op = { kind, buffer: this.engine.current, params } as WorkerOp;
      const next = await this.run(op);
      this.engine.push(next);
      this.afterChange();
    } finally {
      this.busySig.set(false);
    }
  }

  async applyHeal(mask: Uint8Array): Promise<void> {
    if (!this.engine) return;
    this.busySig.set(true);
    try {
      const next = await heal(this.engine.current, mask);
      this.engine.push(next);
      this.afterChange();
    } finally {
      this.busySig.set(false);
    }
  }

  undo(): void {
    if (this.engine?.undo()) this.afterChange(this.engine.canUndo);
  }

  redo(): void {
    if (this.engine?.redo()) this.afterChange();
  }

  current(): PixelBuffer | null {
    return this.engine?.current ?? null;
  }

  async exportPngBlob(): Promise<Blob> {
    const buf = this.engine!.current;
    const canvas = new OffscreenCanvas(buf.width, buf.height);
    const ctx = canvas.getContext('2d')!;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(buf.data), buf.width, buf.height), 0, 0);
    return canvas.convertToBlob({ type: 'image/png' });
  }

  private run(op: WorkerOp): Promise<PixelBuffer> {
    if (typeof Worker === 'undefined') return Promise.resolve(runOpSync(op));
    this.worker ??= new Worker(new URL('./edit-worker', import.meta.url), { type: 'module' });
    return new Promise((resolve, reject) => {
      const w = this.worker!;
      const onMessage = (e: MessageEvent<PixelBuffer>) => {
        w.removeEventListener('message', onMessage);
        w.removeEventListener('error', onError);
        resolve(e.data);
      };
      const onError = (e: ErrorEvent) => {
        w.removeEventListener('message', onMessage);
        w.removeEventListener('error', onError);
        // Worker broke — fall back to the main thread, same math.
        try {
          resolve(runOpSync(op));
        } catch (err) {
          reject(err ?? e);
        }
      };
      w.addEventListener('message', onMessage);
      w.addEventListener('error', onError);
      w.postMessage(op);
    });
  }

  private afterChange(dirty = true): void {
    this.dirtySig.set(dirty);
    this.historyTick.update((n) => n + 1);
    this.refreshPreview();
  }

  private refreshPreview(): void {
    if (typeof OffscreenCanvas === 'undefined') return; // vitest
    void this.exportPngBlob().then((blob) => {
      this.revokePreview();
      this.objectUrl = URL.createObjectURL(blob);
      this.previewSig.set(this.objectUrl);
    });
  }

  private revokePreview(): void {
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = '';
    this.previewSig.set('');
  }
}
