import { r2Storage } from './r2.ts';
import { supabaseStorage } from './supabase.ts';
import type { StorageAdapter, StorageBackend } from './types.ts';

export type { StorageAdapter, StorageBackend } from './types.ts';

export function storageFor(backend: StorageBackend): StorageAdapter {
  return backend === 'r2' ? r2Storage : supabaseStorage;
}

export function videoPath(userId: string, generationId: string): string {
  return `videos/${userId}/${generationId}.mp4`;
}

export function thumbPath(userId: string, generationId: string): string {
  return `videos/${userId}/${generationId}.jpg`;
}
