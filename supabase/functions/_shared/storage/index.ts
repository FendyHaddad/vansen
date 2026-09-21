import { r2Storage } from './r2.ts';
import { supabaseStorage } from './supabase.ts';
import type { StorageAdapter, StorageBackend } from './types.ts';

export type { StorageAdapter, StorageBackend } from './types.ts';

/**
 * Ceilings on what may be read into memory, NOT on what a customer may keep.
 *
 * `StorageAdapter.put` takes bytes (R2's S3 PutObject rejects the chunked
 * encoding fetch uses for a streaming body), so a download is held whole while
 * it is written. With a content-length the peak allocation equals the file;
 * without one the reader halves its own budget, because it has to concatenate.
 *
 * 128 MiB is sized to stay clear of the edge runtime's memory limit while
 * leaving headroom over a 4K clip at the longest supported duration. It is a
 * reasoned ceiling, not a measured one: see the P4 verification log — it must
 * be exercised against the deployed runtime before video rollout.
 */
export const MAX_VIDEO_BYTES = 128 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

/** What a video download is allowed to claim to be. */
export const VIDEO_CONTENT_TYPES = new Set([
  'video/mp4',
  'video/quicktime',
  'video/webm',
]);

export function storageFor(backend: StorageBackend): StorageAdapter {
  return backend === 'r2' ? r2Storage : supabaseStorage;
}

export function videoPath(userId: string, generationId: string): string {
  return `videos/${userId}/${generationId}.mp4`;
}

export function thumbPath(userId: string, generationId: string): string {
  return `videos/${userId}/${generationId}.jpg`;
}
