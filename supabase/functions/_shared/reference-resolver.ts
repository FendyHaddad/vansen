// One owner check for every path a caller can name. The service-role client
// bypasses storage RLS, so a raw caller-supplied key must never reach it: a
// reference is only usable when its registry row says this user owns it, it was
// stored for this purpose, and moderation allowed it.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';

// 'mask' joined the list in 0020: an edit mask is a stored, owned object like
// any other input, not base64 carried in a request body.
export type UploadPurpose = 'reference' | 'persona-photo' | 'mask';
export type ReferenceError = 'not_found' | 'not_owned' | 'not_moderated' | 'wrong_purpose';

export interface OwnedUpload {
  path: string;
  mime: string;
  width: number;
  height: number;
}

/** `<uuid>/<uuid>.<ext>` under the caller's own prefix. Rejects quarantine/,
 * scratch/, persona-zips/ and anything containing a path segment we did not
 * write ourselves. */
const CANONICAL = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(png|jpg|jpeg|webp)$/i;

export function isCanonicalUploadPath(path: string, userId: string): boolean {
  if (!CANONICAL.test(path)) return false;
  return path.startsWith(`${userId}/`);
}

export async function resolveOwnedUpload(
  admin: SupabaseClient,
  userId: string,
  uploadId: string,
  purpose: UploadPurpose,
): Promise<OwnedUpload | ReferenceError> {
  if (!isCanonicalUploadPath(uploadId, userId)) return 'not_owned';
  const { data } = await admin
    .from('uploads')
    .select('user_id,path,purpose,mime,width,height,moderation')
    .eq('path', uploadId)
    .maybeSingle();
  if (!data) return 'not_found';
  if (data.user_id !== userId) return 'not_owned';
  if (data.purpose !== purpose) return 'wrong_purpose';
  if (data.moderation !== 'allowed') return 'not_moderated';
  return {
    path: data.path as string,
    mime: data.mime as string,
    width: Number(data.width),
    height: Number(data.height),
  };
}
