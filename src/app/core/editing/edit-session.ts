import { Injectable, computed, inject, signal } from '@angular/core';
import { GenerationDto } from '../api/dtos';
import { MediaCache } from '../media/media-cache';
import { EditEngine } from './edit-engine';
import { PixelBuffer } from './pixel-buffer';
import { WorkerOp, runOpSync } from './edit-worker';

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
  /** Invalidates in-flight previewOp results (bumped on commit/reset). */
  private previewToken = 0;
  /** Drops out-of-order preview renders (blob encoding is async). */
  private renderSeq = 0;
  /** Serializes worker ops — concurrent posts would cross-resolve replies. */
  private opQueue: Promise<unknown> = Promise.resolve();

  private readonly itemSig = signal<GenerationDto | null>(null);
  private readonly dirtySig = signal(false);
  private readonly busySig = signal(false);
  private readonly previewSig = signal('');
  private readonly historyTick = signal(0);
  /** Uncommitted slider preview — drawn by the viewport over the image. */
  private readonly previewBufSig = signal<PixelBuffer | null>(null);

  /** Viewport magnification — lives here so the panel's buttons and the
   * canvas viewport share it without extra wiring. */
  private readonly zoomSig = signal(1);

  readonly item = this.itemSig.asReadonly();
  readonly dirty = this.dirtySig.asReadonly();
  readonly busy = this.busySig.asReadonly();
  readonly zoom = this.zoomSig.asReadonly();
  readonly previewUrl = this.previewSig.asReadonly();
  readonly previewBuffer = this.previewBufSig.asReadonly();
  readonly canUndo = computed(() => {
    this.historyTick();
    return this.engine?.canUndo ?? false;
  });
  readonly canRedo = computed(() => {
    this.historyTick();
    return this.engine?.canRedo ?? false;
  });

  private readonly media = inject(MediaCache);

  /** Browser entry: decode the media into pixels, then start the session. */
  async open(item: GenerationDto): Promise<void> {
    this.busySig.set(true);
    try {
      const bitmap = await createImageBitmap(await this.media.blob(item.id, item.mediaUrl));
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
    this.zoomSig.set(1);
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
    this.zoomSig.set(1);
    this.previewBufSig.set(null);
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

  /**
   * Compute an op's result as an uncommitted preview buffer — live feedback
   * while the user drags a slider. The viewport paints it straight to a
   * canvas (no PNG round-trip). Stale results are dropped.
   */
  async previewOp(kind: WorkerOp['kind'], params: unknown): Promise<void> {
    if (!this.engine) return;
    const token = ++this.previewToken;
    const op = { kind, buffer: this.engine.current, params } as WorkerOp;
    const next = await this.run(op);
    if (token === this.previewToken) this.previewBufSig.set(next);
  }

  /** Discard any uncommitted preview and show the committed pixels again. */
  resetPreview(): void {
    this.previewToken++;
    this.previewBufSig.set(null);
  }

  /**
   * One brush-stroke step applied on top of the current preview (falling back
   * to committed pixels) — liquify drags accumulate here without touching
   * history. The base is read inside the queue so steps chain in order.
   */
  strokeOp(kind: WorkerOp['kind'], params: unknown): Promise<void> {
    return this.enqueue(async () => {
      if (!this.engine) return;
      const token = this.previewToken;
      const base = this.previewBufSig() ?? this.engine.current;
      const next = await this.dispatch({ kind, buffer: base, params } as WorkerOp);
      if (token === this.previewToken) this.previewBufSig.set(next);
    });
  }

  /** Commit the accumulated stroke preview as ONE undoable history entry. */
  async commitStroke(): Promise<void> {
    await this.opQueue; // let queued stroke steps land first
    const buf = this.previewBufSig();
    if (!buf || !this.engine) return;
    this.engine.push(buf);
    this.afterChange();
  }

  async applyHeal(mask: Uint8Array): Promise<void> {
    if (!this.engine) return;
    this.busySig.set(true);
    try {
      const engine = this.engine;
      let next: PixelBuffer | null = null;
      // MI-GAN inpainting first (model downloads on first use); offline or
      // any engine failure falls back to the local PatchMatch worker op.
      // OffscreenCanvas guard = same browser-only marker used elsewhere, so
      // vitest never reaches for the network.
      if (typeof OffscreenCanvas !== 'undefined') {
        try {
          const { healSmart } = await import('./heal-engine');
          next = await this.enqueue(() => healSmart(engine.current, mask));
        } catch {
          next = null;
        }
      }
      next ??= await this.run({ kind: 'heal', buffer: engine.current, params: { mask } } as WorkerOp);
      if (this.engine !== engine) return; // session closed mid-heal
      engine.push(next);
      this.afterChange();
    } finally {
      this.busySig.set(false);
    }
  }

  zoomIn(): void {
    this.zoomSig.update((z) => Math.min(4, z * 1.25));
  }

  zoomOut(): void {
    this.zoomSig.update((z) => Math.max(0.25, z / 1.25));
  }

  resetZoom(): void {
    this.zoomSig.set(1);
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
    return this.exportBlob('image/png');
  }

  /** Encode the committed pixels for download in the chosen format. */
  async exportBlob(type: 'image/png' | 'image/jpeg' | 'image/webp', quality?: number): Promise<Blob> {
    return bufferToBlob(this.engine!.current, type, quality);
  }

  private run(op: WorkerOp): Promise<PixelBuffer> {
    return this.enqueue(() => this.dispatch(op));
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.opQueue.then(task);
    this.opQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private dispatch(op: WorkerOp): Promise<PixelBuffer> {
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
    this.previewToken++; // committed state wins over any in-flight preview
    // Keep the overlay showing the committed pixels while the <img> below
    // re-encodes — otherwise the image flashes back to its pre-apply state.
    // Dimension changes (crop/rotate) drop it: the overlay box would be stale.
    const cur = this.engine?.current ?? null;
    const prev = this.previewBufSig();
    this.previewBufSig.set(
      cur && prev && prev.width === cur.width && prev.height === cur.height ? cur : null,
    );
    this.dirtySig.set(dirty);
    this.historyTick.update((n) => n + 1);
    this.refreshPreview();
  }

  private refreshPreview(): void {
    if (typeof OffscreenCanvas === 'undefined' || !this.engine) return; // vitest
    const seq = ++this.renderSeq;
    void bufferToBlob(this.engine.current).then((blob) => {
      if (seq !== this.renderSeq) return;
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

function bufferToBlob(buf: PixelBuffer, type = 'image/png', quality?: number): Promise<Blob> {
  const canvas = new OffscreenCanvas(buf.width, buf.height);
  const ctx = canvas.getContext('2d')!;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(buf.data), buf.width, buf.height), 0, 0);
  return canvas.convertToBlob({ type, quality });
}
