export type StorageBackend = 'supabase' | 'r2';

/**
 * Object storage behind one interface. `put` takes the whole body as bytes on
 * purpose: a streaming request body makes fetch use chunked transfer encoding,
 * which R2's S3 PutObject rejects. Callers must therefore cap the size BEFORE
 * they buffer — see MAX_VIDEO_BYTES.
 */
export interface StorageAdapter {
  readonly backend: StorageBackend;
  put(path: string, body: Uint8Array, contentType: string): Promise<void>;
  signedUrl(path: string, ttlS: number): Promise<string>;
  delete(path: string): Promise<void>;
}
