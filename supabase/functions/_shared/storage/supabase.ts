import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import type { StorageAdapter } from './types.ts';

const BUCKET = 'media';

// Built on first use, not on import: `api/app.ts` pulls this module in only for
// thumbPath/videoPath, and the test harness must be able to import the gateway
// without service-role secrets in the environment.
let client: SupabaseClient | null = null;
function admin(): SupabaseClient {
  if (client) return client;
  client = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
  return client;
}

export const supabaseStorage: StorageAdapter = {
  backend: 'supabase',
  async put(path, body, contentType) {
    const { error } = await admin().storage
      .from(BUCKET)
      .upload(path, body, { contentType, upsert: true });
    if (error) throw new Error(`supabase upload failed: ${error.message}`);
  },
  async signedUrl(path, ttlS) {
    const { data, error } = await admin().storage.from(BUCKET).createSignedUrl(path, ttlS);
    if (error || !data) throw new Error(`supabase sign failed: ${error?.message}`);
    return data.signedUrl;
  },
  async delete(path) {
    const { error } = await admin().storage.from(BUCKET).remove([path]);
    if (error) throw new Error(`supabase delete failed: ${error.message}`);
  },
};
