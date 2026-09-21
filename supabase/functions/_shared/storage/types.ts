export type StorageBackend = 'supabase' | 'r2';

/**
 * Everything needed to find one object and nothing else. A path alone is not
 * a locator: `<user>/<id>.png` exists in both `media` and `uploads`, and the
 * pre-P6 code that deleted by path alone could remove the wrong one.
 */
export interface ObjectRef {
  backend: StorageBackend;
  bucket: string;
  path: string;
}

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
  /**
   * Whether the object is still there. Only a definite answer counts: an
   * adapter that cannot reach the backend THROWS rather than reporting
   * absence, because "I could not ask" and "it is gone" must never be the
   * same value to a deletion worker.
   */
  exists?(path: string): Promise<boolean>;
}
