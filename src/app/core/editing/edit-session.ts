import { Injectable, computed, inject, signal } from '@angular/core';
import { SessionLifecycle } from '../auth/session-lifecycle';
import { GenerationDto } from '../api/dtos';
import { MediaCache } from '../media/media-cache';
import { EditEngine } from './edit-engine';
import { resizeBilinear } from './engines/raster';
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
  /** Memoized downscaled copy of the committed pixels for cheap previews. */
  private smallBase: { src: Uint8ClampedArray; maxDim: number; buf: PixelBuffer } | null = null;

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

  /** Last canvas click in image px for point-driven tools (bokeh focus,
   * smart select) — the viewport writes it, tool options react to it. */
  private readonly pointPickSig = signal<{ x: number; y: number } | null>(null);

  readonly item = this.itemSig.asReadonly();
  readonly dirty = this.dirtySig.asReadonly();
  readonly busy = this.busySig.asReadonly();
  readonly zoom = this.zoomSig.asReadonly();
  readonly pointPick = this.pointPickSig.asReadonly();
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

  /**
   * Identifies one opening. An async open captures it before awaiting and
   * checks it after; a close or a second open invalidates it.
   *
   * `open()` decodes an image, which takes hundreds of milliseconds on a
   * large file. Without this, navigating away mid-decode still ran
   * `openWithBuffer` and repopulated a session the user had already left.
   */
  private readonly openTokenSig = signal(0);

  /**
   * Bumped by every committed change. A save carries the revision it was
   * taken at, so a save that lands after a later edit cannot claim the
   * session is clean — which would tell the customer their newest work is
   * saved when it is not.
   */
  private readonly revisionSig = signal(0);

  /**
   * Set when an identity change discarded unsaved pixels, so the UI can say
   * so. Cleared when the next session opens.
   */
  private readonly discardedOnSignOutSig = signal(false);

  readonly openToken = this.openTokenSig.asReadonly();
  readonly revision = this.revisionSig.asReadonly();
  readonly discardedOnSignOut = this.discardedOnSignOutSig.asReadonly();

  /** Rejects the operation the worker is currently running (see `dispatch`). */
  private cancelWorkerTask: (() => void) | null = null;

  constructor() {
    inject(SessionLifecycle).register('edit-session', this);
  }

  /**
   * Identity changed under us. The previous account's pixels cannot stay, but
   * losing work without a word is worse than saying it plainly.
   */
  reset(): void {
    const lost = this.dirtySig();
    this.close();
    this.discardedOnSignOutSig.set(lost);
  }

  /** The UI acknowledged the loss notice. */
  clearDiscardNotice(): void {
    this.discardedOnSignOutSig.set(false);
  }

  /** Browser entry: decode the media into pixels, then start the session. */
  async open(item: GenerationDto): Promise<void> {
    const token = this.beginOpen();
    this.busySig.set(true);
    let bitmap: ImageBitmap | undefined;
    try {
      bitmap = await createImageBitmap(await this.media.blob(item.id, item.mediaUrl));
      // Decoding took time. If the customer left, or opened something else,
      // these pixels belong to a session that no longer exists.
      if (token !== this.openTokenSig()) return;
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      const img = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      this.completeOpen(token, item, { width: img.width, height: img.height, data: img.data });
    } finally {
      bitmap?.close();
      // A stale open must not clear the CURRENT session's busy flag.
      if (token === this.openTokenSig()) this.busySig.set(false);
    }
  }

  /** Starts an opening: tears down whatever was open and returns its token. */
  beginOpen(): number {
    this.close();
    return this.openTokenSig();
  }

  /** Installs decoded pixels, but only for the opening that is still current. */
  completeOpen(token: number, item: GenerationDto, buf: PixelBuffer): void {
    if (token !== this.openTokenSig()) return;
    this.revisionSig.set(0);
    this.discardedOnSignOutSig.set(false);
    this.engine = new EditEngine(buf);
    this.itemSig.set(item);
    this.dirtySig.set(false);
    this.zoomSig.set(1);
    this.historyTick.update((n) => n + 1);
    this.refreshPreview();
  }

  /** Test seam + shared init. */
  openWithBuffer(item: GenerationDto, buf: PixelBuffer): void {
    this.completeOpen(this.beginOpen(), item, buf);
  }

  /**
   * After a save: keep editing the same pixels under the new version's
   * identity — but only if nothing changed while the save was in flight.
   *
   * Both halves matter. The revision catches an edit made during the save;
   * the token catches a different image, because two images both start at
   * revision zero.
   */
  adoptItem(
    saved: GenerationDto,
    savedAtRevision: number,
    savedAtToken: number,
  ): 'adopted' | 'stale' {
    if (!this.itemSig()) return 'stale';
    if (savedAtToken !== this.openTokenSig()) return 'stale';
    if (savedAtRevision !== this.revisionSig()) return 'stale';
    this.itemSig.set(saved);
    this.dirtySig.set(false);
    return 'adopted';
  }

  close(): void {
    // Invalidate first: everything in flight checks this before publishing.
    this.openTokenSig.update((n) => n + 1);
    this.previewToken++;
    this.renderSeq++;
    // Terminating a worker does not settle the promise waiting on it. The
    // caller would await forever, and its `finally` would never run.
    this.cancelWorkerTask?.();
    this.cancelWorkerTask = null;
    this.worker?.terminate();
    this.worker = null;
    this.opQueue = Promise.resolve();
    this.engine = null;
    this.smallBase = null;
    this.itemSig.set(null);
    this.dirtySig.set(false);
    this.busySig.set(false);
    this.zoomSig.set(1);
    this.pointPickSig.set(null);
    this.previewBufSig.set(null);
    this.historyTick.update((n) => n + 1);
    this.revokePreview();
  }

  async apply(kind: WorkerOp['kind'], params: unknown): Promise<void> {
    const engine = this.engine;
    if (!engine) return;
    const token = this.openTokenSig();
    this.busySig.set(true);
    try {
      const next = await this.run({ kind, buffer: engine.current, params } as WorkerOp);
      // The image changed under us while the worker was busy. Pushing this
      // into the new engine would paint one image's edit onto another.
      if (!this.owns(token, engine)) return;
      engine.push(next);
      this.afterChange();
    } catch (error) {
      if (isAbort(error)) return; // a close, not a failure
      throw error;
    } finally {
      if (this.owns(token, engine)) this.busySig.set(false);
    }
  }

  /** Is this still the session the operation began in? */
  private owns(token: number, engine: EditEngine | null): boolean {
    return token === this.openTokenSig() && engine === this.engine;
  }

  /**
   * Compute an op's result as an uncommitted preview buffer — live feedback
   * while the user drags a slider. The viewport paints it straight to a
   * canvas (no PNG round-trip). Stale results are dropped.
   *
   * `maxDim` runs the op on a downscaled copy (the overlay canvas CSS-scales
   * back up) — geometry sliders stay smooth on huge images; Apply is full-res.
   */
  async previewOp(kind: WorkerOp['kind'], params: unknown, maxDim?: number): Promise<void> {
    const engine = this.engine;
    if (!engine) return;
    const openToken = this.openTokenSig();
    const token = ++this.previewToken;
    const op = { kind, buffer: this.previewBase(maxDim), params } as WorkerOp;
    try {
      const next = await this.run(op);
      if (!this.owns(openToken, engine)) return;
      if (token === this.previewToken) this.previewBufSig.set(next);
    } catch (error) {
      if (isAbort(error)) return;
      throw error;
    }
  }

  /**
   * The committed pixels at `maxDim`, with the factor that got them there.
   *
   * Engine previews (bokeh) need both: the smaller buffer to run on, and the
   * scale to move the customer's focus point into it.
   */
  proxy(maxDim: number): { buf: PixelBuffer; scale: number } | null {
    if (!this.engine) return null;
    const cur = this.engine.current;
    const buf = this.previewBase(maxDim);
    return { buf, scale: buf.width / cur.width };
  }

  /** Committed pixels, downscaled to `maxDim` and memoized per commit. */
  private previewBase(maxDim?: number): PixelBuffer {
    const cur = this.engine!.current;
    const long = Math.max(cur.width, cur.height);
    if (!maxDim || long <= maxDim) return cur;
    if (this.smallBase?.src === cur.data && this.smallBase.maxDim === maxDim) {
      return this.smallBase.buf;
    }
    const k = maxDim / long;
    const buf = resizeBilinear(
      cur,
      Math.max(1, Math.round(cur.width * k)),
      Math.max(1, Math.round(cur.height * k)),
    );
    this.smallBase = { src: cur.data, maxDim, buf };
    return buf;
  }

  /** Discard any uncommitted preview and show the committed pixels again. */
  resetPreview(): void {
    this.previewToken++;
    this.previewBufSig.set(null);
  }

  /** Point-tool click routing (bokeh focus, smart select). */
  setPointPick(p: { x: number; y: number } | null): void {
    this.pointPickSig.set(p);
  }

  /** Show an externally computed buffer as the uncommitted preview
   * (engine tools render outside the worker-op pipeline). */
  showPreviewBuffer(buf: PixelBuffer): void {
    this.previewToken++; // cancel any in-flight worker preview
    this.previewBufSig.set(buf);
  }

  /**
   * Run an engine (ONNX) op on the current pixels and commit the result as
   * one undoable step. Serialized on the same queue as worker ops.
   */
  async applyEngine(run: (buf: PixelBuffer) => Promise<PixelBuffer>): Promise<void> {
    const engine = this.engine;
    if (!engine) return;
    const token = this.openTokenSig();
    this.busySig.set(true);
    try {
      const next = await this.enqueue(() => run(engine.current));
      if (!this.owns(token, engine)) return; // session closed mid-run
      engine.push(next);
      this.afterChange();
    } catch (error) {
      if (isAbort(error)) return;
      throw error;
    } finally {
      if (this.owns(token, engine)) this.busySig.set(false);
    }
  }

  /**
   * One brush-stroke step applied on top of the current preview (falling back
   * to committed pixels) — liquify drags accumulate here without touching
   * history. The base is read inside the queue so steps chain in order.
   */
  strokeOp(kind: WorkerOp['kind'], params: unknown): Promise<void> {
    const openToken = this.openTokenSig();
    return this.enqueue(async () => {
      const engine = this.engine;
      if (!engine || !this.owns(openToken, engine)) return;
      const token = this.previewToken;
      const base = this.previewBufSig() ?? engine.current;
      const next = await this.dispatch({ kind, buffer: base, params } as WorkerOp);
      if (!this.owns(openToken, engine)) return;
      if (token === this.previewToken) this.previewBufSig.set(next);
    }).catch((error) => {
      if (isAbort(error)) return;
      throw error;
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
    const engine = this.engine;
    if (!engine) return;
    const token = this.openTokenSig();
    this.busySig.set(true);
    try {
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
      if (!this.owns(token, engine)) return; // session closed mid-heal
      engine.push(next);
      this.afterChange();
    } catch (error) {
      if (isAbort(error)) return;
      throw error;
    } finally {
      if (this.owns(token, engine)) this.busySig.set(false);
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
    const token = this.openTokenSig();
    const engine = this.engine;
    return this.enqueue(() => {
      // Queued behind other work; by the time it reaches the front the
      // session may be gone. Posting it would start work nobody wants and
      // hand the reply to whatever opened next.
      if (!this.owns(token, engine)) return Promise.reject(abortError());
      return this.dispatch(op);
    });
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
      // Dispatch is serialized, so there is exactly one of these at a time.
      // `close()` calls it to settle the promise the caller is awaiting —
      // terminating the worker on its own leaves that promise forever
      // pending, and the caller's `finally` never runs.
      const cleanup = () => {
        w.removeEventListener('message', onMessage);
        w.removeEventListener('error', onError);
        this.cancelWorkerTask = null;
      };
      const onMessage = (e: MessageEvent<PixelBuffer>) => {
        cleanup();
        resolve(e.data);
      };
      const onError = (e: ErrorEvent) => {
        cleanup();
        // Worker broke — fall back to the main thread, same math.
        try {
          resolve(runOpSync(op));
        } catch (err) {
          reject(err ?? e);
        }
      };
      this.cancelWorkerTask = () => {
        cleanup();
        reject(abortError());
      };
      w.addEventListener('message', onMessage);
      w.addEventListener('error', onError);
      try {
        w.postMessage(op);
      } catch (err) {
        cleanup();
        reject(err);
      }
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
    this.revisionSig.update((n) => n + 1);
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

/**
 * Cancellation, not failure. A closed session settles everything it was
 * waiting on with this, and every caller treats it as "nothing to do".
 */
function abortError(): DOMException {
  return new DOMException('Edit session closed', 'AbortError');
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
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
