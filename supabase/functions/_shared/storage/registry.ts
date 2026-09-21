// Every byte we write, named before it exists.
//
// The registry is what makes deletion possible at all. Until P6 the only
// record of an object was the row that referenced it, so dropping that row
// (an account deletion, a lapse purge, a failed save) left bytes nobody could
// ever name again. An intent row is written BEFORE the upload: a write whose
// response never came back still leaves a locator behind, and an orphan we
// can find is a different thing from an orphan we cannot.
//
// A registry write that fails is fatal to the upload. Storing bytes we did not
// record is the exact failure this module exists to prevent.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import type { ObjectRef } from './types.ts';

export type { ObjectRef } from './types.ts';

export type ObjectPurpose =
  | 'media'
  | 'thumb'
  | 'upload'
  | 'persona-photo'
  | 'persona-zip'
  | 'scratch'
  | 'quarantine';

export interface RegisterInput extends ObjectRef {
  userId: string;
  purpose: ObjectPurpose;
}

/** Records the intent to write. Returns the registry id. Throws on failure. */
export async function registerObject(
  admin: SupabaseClient,
  input: RegisterInput,
): Promise<string> {
  const { data, error } = await admin.rpc('fn_register_object', {
    p_user: input.userId,
    p_backend: input.backend,
    p_bucket: input.bucket,
    p_path: input.path,
    p_purpose: input.purpose,
  });
  if (error) throw new Error(`register_object_failed: ${error.message}`);
  if (!data) throw new Error('register_object_failed: no id returned');
  return String(data);
}

/**
 * The write landed and something now references it. Not fatal: the object is
 * already tracked, and a `staged` row is cleaned up by the inventory rather
 * than lost.
 */
export async function markObjectLive(
  admin: SupabaseClient,
  id: string,
): Promise<boolean> {
  const { data, error } = await admin.rpc('fn_mark_object_live', { p_id: id });
  if (error) {
    console.error('mark_object_live_failed', id, error.message);
    return false;
  }
  return data === true;
}

/**
 * Queue objects for removal by registry id. The cleanup worker owns them from
 * here; a storage failure becomes a retry, never a refusal to the customer.
 */
export async function enqueueDeletions(
  admin: SupabaseClient,
  ids: string[],
  reason: string,
): Promise<number> {
  if (ids.length === 0) return 0;
  const { data, error } = await admin.rpc('fn_enqueue_deletions', {
    p_objects: ids,
    p_reason: reason,
  });
  if (error) throw new Error(`enqueue_deletions_failed: ${error.message}`);
  return Number(data ?? 0);
}

/** Keep an object beyond deletion until a date — evidence, not content. */
export async function holdObject(
  admin: SupabaseClient,
  id: string,
  until: Date,
): Promise<boolean> {
  const { data, error } = await admin.rpc('fn_hold_object', {
    p_id: id,
    p_until: until.toISOString(),
  });
  if (error) {
    console.error('hold_object_failed', id, error.message);
    return false;
  }
  return data === true;
}

/**
 * Register, write, then mark live. Anything that throws leaves a `staged`
 * locator behind on purpose: that is the record the inventory reconciles.
 */
export async function putTracked(
  admin: SupabaseClient,
  input: RegisterInput,
  put: () => Promise<void>,
): Promise<string> {
  const id = await registerObject(admin, input);
  await put();
  await markObjectLive(admin, id);
  return id;
}
