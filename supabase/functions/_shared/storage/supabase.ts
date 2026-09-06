import { createClient } from 'jsr:@supabase/supabase-js@2';
import type { StorageAdapter } from './types.ts';

const BUCKET = 'media';

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

export const supabaseStorage: StorageAdapter = {
  backend: 'supabase',
  async put(path, body, contentType) {
    const { error } = await admin.storage
      .from(BUCKET)
      .upload(path, body, { contentType, upsert: true });
    if (error) throw new Error(`supabase upload failed: ${error.message}`);
  },
  async signedUrl(path, ttlS) {
    const { data, error } = await admin.storage.from(BUCKET).createSignedUrl(path, ttlS);
    if (error || !data) throw new Error(`supabase sign failed: ${error?.message}`);
    return data.signedUrl;
  },
  async delete(path) {
    const { error } = await admin.storage.from(BUCKET).remove([path]);
    if (error) throw new Error(`supabase delete failed: ${error.message}`);
  },
};
