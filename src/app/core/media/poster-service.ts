import { inject, Injectable } from '@angular/core';
import { ApiService } from '../api/api-service';
import type { ThumbResponse } from '../api/dtos';
import { GenerationStore, type GenerationItem } from '../generations/generation-store';

export const POSTER_MAX_BYTES = 512 * 1024;
const SEEK_S = 0.5;
const JPEG_QUALITY = 0.8;
const LOAD_TIMEOUT_MS = 15_000;

@Injectable({ providedIn: 'root' })
export class PosterService {
  private readonly api = inject(ApiService);
  private readonly store = inject(GenerationStore);
  private readonly attempted = new Set<string>();

  /** Generate + upload a poster for a finished video that has none. One attempt per id per session. */
  ensure(item: GenerationItem): void {
    if (item.kind !== 'video' || item.status !== 'done' || item.thumbUrl || !item.mediaUrl) return;
    if (this.attempted.has(item.id)) return;
    this.attempted.add(item.id);
    void this.run(item);
  }

  private async run(item: GenerationItem): Promise<void> {
    try {
      const blob = await this.captureFrame(item.mediaUrl, SEEK_S);
      if (blob.size > POSTER_MAX_BYTES) return;
      const form = new FormData();
      form.append('file', blob, `${item.id}.jpg`);
      const res = await this.api.postForm<ThumbResponse>(`/generations/${item.id}/thumb`, form);
      this.store.setThumb(item.id, res.thumbUrl);
    } catch (e) {
      // Fallback tile is fine; never retry this session.
      console.warn('[poster] frame capture/upload failed', item.id, e);
    }
  }

  captureFrame(url: string, atS = SEEK_S): Promise<Blob> {
    return new Promise<Blob>((resolve, reject) => {
      const video = document.createElement('video');
      video.crossOrigin = 'anonymous';
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';
      const timer = setTimeout(() => finish(new Error('poster timeout')), LOAD_TIMEOUT_MS);

      const finish = (err: Error | null, blob?: Blob) => {
        clearTimeout(timer);
        video.removeAttribute('src');
        video.load();
        if (err || !blob) {
          reject(err ?? new Error('poster failed'));
          return;
        }
        resolve(blob);
      };

      video.addEventListener('loadedmetadata', () => {
        video.currentTime = Math.min(atS, Math.max(0, video.duration - 0.1));
      }, { once: true });
      video.addEventListener('seeked', () => {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          finish(new Error('no 2d context'));
          return;
        }
        ctx.drawImage(video, 0, 0);
        canvas.toBlob((b) => finish(b ? null : new Error('toBlob null'), b ?? undefined), 'image/jpeg', JPEG_QUALITY);
      }, { once: true });
      video.addEventListener('error', () => finish(new Error('video load error')), { once: true });
      video.src = url;
    });
  }
}
