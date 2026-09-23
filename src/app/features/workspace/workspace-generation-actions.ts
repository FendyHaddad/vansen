// Submit / retry / variation / upscale / delete / download / AI-edit actions
// for the workspace page, moved out of WorkspacePage verbatim. Owns the
// per-item busy-spinner set; component-scoped (see `WorkspacePage`'s
// `providers`). Some call sites thread a side effect in via callback
// (`onSuccess`, `onApplied`, the mask thunk) instead of reaching the component.
import { Injectable, inject, signal } from '@angular/core';
import { ApiError } from '../../core/api/api-service';
import type { CreateGenerationRequest } from '../../core/api/dtos';
import { EditSession } from '../../core/editing/edit-session';
import { editToolById } from '../../core/catalog/model-families';
import { GenerationOp } from '../../core/enums';
import { GenerationStore } from '../../core/generations/generation-store';
import { JobPoller } from '../../core/jobs/job-poller';
import { MediaCache } from '../../core/media/media-cache';
import { WorkspaceNotices } from './workspace-notices';

async function fetchBlob(url: string): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`media fetch failed: ${res.status}`);
  return res.blob();
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * The server's own explanation for a refused retry or variation.
 *
 * These are 409s with a message written for a customer — "the reference image
 * this used is no longer available" beats "Retry failed", and there is
 * nothing for them to retry, so no generic error banner either.
 */
function refusalMessage(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null;
  if (e.status !== 409) return null;
  return e.message;
}

@Injectable()
export class WorkspaceGenerationActions {
  private readonly store = inject(GenerationStore);
  private readonly poller = inject(JobPoller);
  private readonly mediaCache = inject(MediaCache);
  private readonly editSession = inject(EditSession);
  private readonly notices = inject(WorkspaceNotices);

  /** Item ids with an action (retry/delete/upscale/variation/download) in flight —
   * their buttons show a spinner and ignore repeat clicks. */
  readonly busyIds = signal<Set<string>>(new Set());

  private async withBusy(id: string, fn: () => Promise<void>): Promise<void> {
    if (this.busyIds().has(id)) return;
    this.busyIds.update((s) => new Set(s).add(id));
    try {
      await fn();
    } finally {
      this.busyIds.update((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }
  }

  async submit(request: CreateGenerationRequest, onSuccess?: () => void): Promise<void> {
    await this.store.create(request);
    onSuccess?.();
    this.notices.notice.set('');
    this.poller.watch();
  }

  async upscale(id: string): Promise<void> {
    await this.withBusy(id, async () => {
      const item = this.store.byId(id);
      if (!item || item.kind !== 'image') return;
      try {
        await this.store.create({
          op: GenerationOp.Upscale,
          prompt: item.prompt,
          settings: item.settings,
          batch: 1,
          parentId: item.id,
        });
        this.notices.notice.set('');
        this.poller.watch();
      } catch (e) {
        this.notices.showError(e, 'Upscale failed');
      }
    });
  }

  async variation(id: string): Promise<void> {
    await this.rerun(id, () => this.store.variation(id), 'Variation failed');
  }

  /** Re-submit a failed generation with the same settings. */
  async retry(id: string): Promise<void> {
    await this.rerun(id, () => this.store.retry(id), 'Retry failed');
  }

  /**
   * Retry and variation are server operations now: it holds the snapshot of
   * what was actually asked for, so it rebuilds the request. A 409 means the
   * server can explain why it cannot, and that explanation is worth more to
   * the customer than a generic failure.
   */
  private async rerun(id: string, run: () => Promise<unknown>, fallback: string): Promise<void> {
    await this.withBusy(id, async () => {
      try {
        await run();
        this.notices.notice.set('');
        this.poller.watch();
      } catch (e) {
        const refusal = refusalMessage(e);
        if (refusal) {
          this.notices.notice.set(refusal);
          return;
        }
        this.notices.showError(e, fallback);
      }
    });
  }

  /** Cancel a still-rendering video job from its pending card. */
  async cancel(id: string): Promise<void> {
    try {
      await this.store.cancel(id);
      // No refund is promised here: the worker asks the provider, and a render
      // that has already started keeps going and keeps its credits.
      this.notices.notice.set('Cancelling — we\'ll refund if it stops in time.');
    } catch (e) {
      this.notices.showError(e, 'Could not cancel');
    }
  }

  async deleteOne(id: string, afterAttempt: () => void): Promise<void> {
    await this.withBusy(id, async () => {
      try {
        await this.store.remove(id);
      } catch (e) {
        this.notices.showError(e, 'Delete failed');
      }
      afterAttempt();
    });
  }

  /** Library grid delete — one card or a multi-select batch. */
  async deleteMany(ids: string[]): Promise<void> {
    for (const id of ids) {
      let failed = false;
      await this.withBusy(id, async () => {
        try {
          await this.store.remove(id);
        } catch (e) {
          this.notices.showError(e, 'Delete failed');
          failed = true;
        }
      });
      if (failed) return;
    }
  }

  async download(id: string): Promise<void> {
    await this.withBusy(id, async () => {
      const item = await this.store.fetchById(id);
      if (!item) return;
      // Images serve from the media cache — an already-viewed image downloads
      // free. Videos stream straight through: multi-MB clips have no business
      // in Cache Storage.
      let blob: Blob;
      try {
        blob =
          item.kind === 'video'
            ? await fetchBlob(item.mediaUrl)
            : await this.mediaCache.blob(item.id, item.mediaUrl);
      } catch {
        this.notices.notice.set('Download failed — the media link may have expired. Reload and retry.');
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `vansen-${item.id}.${item.kind === 'video' ? 'mp4' : 'jpg'}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    });
  }

  async saveEdit(): Promise<void> {
    const item = this.editSession.item();
    if (!item) return;
    // Captured BEFORE the request leaves: what was saved is the state at this
    // revision, of this opening.
    const at = this.editSession.revision();
    const token = this.editSession.openToken();
    try {
      const blob = await this.editSession.exportPngBlob();
      const saved = await this.store.saveEdit(blob, item.id);
      const outcome = this.editSession.adoptItem(saved, at, token);
      if (outcome === 'adopted') {
        this.notices.notice.set('Saved as a new version.');
        return;
      }
      // Telling them "saved" here would mean their newest strokes are safe.
      this.notices.notice.set('Saved — you have newer changes still unsaved.');
    } catch (e) {
      this.notices.showError(e, 'Save failed');
    }
  }

  async aiTool(
    req: { toolId: string; prompt: string; maskPngBase64?: string },
    resolveMask: () => string | undefined,
    onApplied: () => void,
  ): Promise<void> {
    const item = this.editSession.item();
    if (!item) return;
    const tool = editToolById(req.toolId);
    if (!tool) return;

    try {
      // Expand: pad the canvas 25% per side; FLUX fill repaints the border mask.
      if (req.toolId === 'edit-expand') {
        await this.runExpand(item.id);
        return;
      }

      // Ai Select passes its own mask; otherwise the hand-painted mask layer.
      // Resolved here, inside the try and after the expand branch, so Expand
      // never touches the mask canvas and a throw lands in the catch below.
      const mask = resolveMask();
      if (tool.needsMask && !mask) {
        this.notices.notice.set('Paint a mask first — the tool needs to know where to work.');
        return;
      }

      // Persist the current canvas so the AI works on what the user sees.
      const at = this.editSession.revision();
      const token = this.editSession.openToken();
      const saved = this.editSession.dirty()
        ? await this.store.saveEdit(await this.editSession.exportPngBlob(), item.id)
        : item;
      if (saved.id !== item.id) this.editSession.adoptItem(saved, at, token);

      const prompt =
        req.toolId === 'edit-fill'
          ? req.prompt
          : req.toolId === 'edit-remove'
            ? 'remove the masked object and seamlessly continue the background'
            : 'remove background';
      await this.store.create({
        familyId: req.toolId,
        op: GenerationOp.Edit,
        prompt,
        settings: saved.settings,
        batch: 1,
        parentId: saved.id,
        maskPngBase64: mask,
      });
      onApplied();
      this.notices.notice.set('');
      this.poller.watch();
    } catch (e) {
      this.notices.showError(e, 'Edit failed');
    }
  }

  private async runExpand(parentId: string): Promise<void> {
    const buf = this.editSession.current();
    if (!buf) return;
    const padX = Math.round(buf.width * 0.25);
    const padY = Math.round(buf.height * 0.25);
    const w = buf.width + padX * 2;
    const h = buf.height + padY * 2;
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d')!;
    ctx.putImageData(
      new ImageData(new Uint8ClampedArray(buf.data), buf.width, buf.height),
      padX,
      padY,
    );
    const padded = await canvas.convertToBlob({ type: 'image/png' });
    const maskCanvas = new OffscreenCanvas(w, h);
    const mctx = maskCanvas.getContext('2d')!;
    mctx.fillStyle = '#fff';
    mctx.fillRect(0, 0, w, h);
    mctx.fillStyle = '#000';
    mctx.fillRect(padX, padY, buf.width, buf.height);
    const expandMask = await blobToDataUrl(await maskCanvas.convertToBlob({ type: 'image/png' }));

    const saved = await this.store.saveEdit(padded, parentId);
    await this.store.create({
      familyId: 'edit-expand',
      op: GenerationOp.Edit,
      prompt: 'continue the image naturally beyond its original edges',
      settings: saved.settings,
      batch: 1,
      parentId: saved.id,
      maskPngBase64: expandMask,
    });
    this.notices.notice.set('');
    this.poller.watch();
  }
}
