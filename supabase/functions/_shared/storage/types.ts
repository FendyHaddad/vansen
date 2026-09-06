export type StorageBackend = 'supabase' | 'r2';

export interface StorageAdapter {
  readonly backend: StorageBackend;
  /** Bytes only: R2's S3 PutObject rejects chunked transfer encoding, which is
   * what fetch sends for a streaming body. Callers buffer first. */
  put(path: string, body: Uint8Array, contentType: string): Promise<void>;
  signedUrl(path: string, ttlS: number): Promise<string>;
  delete(path: string): Promise<void>;
}
