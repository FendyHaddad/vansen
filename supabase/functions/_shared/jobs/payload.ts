// The immutable description of work, and how a worker turns it back into a
// provider request.
//
// What is STORED are identities: upload paths, generation ids, a persona id.
// What is RESOLVED, freshly, at the moment of dispatch, are signed URLs — a job
// that waited an hour for its turn would otherwise hand the provider links that
// expired while it queued. Ownership is re-checked here too: the customer may
// have deleted the reference between submitting and dispatch, and a deleted
// input must fail before a provider call, not after one.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import type { SubmitCtx } from '../providers/types.ts';
import type { NormalizedRequest } from '../generation-request.ts';
import { type GenerationSettings, PERSONA_SLOT_ORDER, type VideoMode } from '../model-families.ts';
import type { StorageAdapter, StorageBackend } from '../storage/index.ts';
import { resolveOwnedUpload, type UploadPurpose } from '../reference-resolver.ts';

export interface StoredPayload {
  familyId: string;
  op: string;
  /** The effective prompt — style and persona instruction already applied. */
  prompt: string;
  settings: GenerationSettings;
  providerModel: string;
  providerSettings: Record<string, unknown>;
  quoteVersion: number;
  catalogVersion: string;
  safetyId: string;
  /** Upload PATH of an image reference (the registry's primary handle). */
  referenceUploadId?: string;
  /** A finished generation used as the input image or video. */
  parentId?: string;
  /** Upload path of a stored mask. Masks are never carried as base64. */
  maskUploadId?: string;
  referenceSlots?: { first?: string; last?: string; references?: string[] };
  personaId?: string;
  trendId?: string;
  mode?: VideoMode;
}

export interface PayloadJob {
  id: string;
  user_id: string;
  generation_id: string;
  payload: Record<string, unknown>;
}

export interface PayloadDeps {
  admin: SupabaseClient;
  storageFor: (backend: StorageBackend) => StorageAdapter;
  /** How long the provider has to fetch what we sign. */
  signTtlS?: number;
}

const DEFAULT_TTL_S = 3600;

export async function resolvePayload(
  deps: PayloadDeps,
  job: PayloadJob,
): Promise<SubmitCtx> {
  const payload = job.payload as unknown as StoredPayload;
  if (!payload?.familyId) throw new Error('payload_missing');

  const ctx: SubmitCtx = {
    familyId: payload.familyId,
    op: payload.op,
    prompt: payload.prompt,
    settings: { ...(payload.settings ?? {}) },
    normalized: normalizedOf(payload),
    safetyId: payload.safetyId,
    mode: payload.mode,
  };

  const reference = await referenceUrl(deps, job.user_id, payload);
  if (reference) ctx.referenceUrl = reference;

  const mask = await maskBase64(deps, job.user_id, payload);
  if (mask) ctx.maskPngBase64 = mask;

  const photos = await personaPhotos(deps, job.user_id, payload);
  if (photos.length > 0) ctx.personaPhotos = photos;

  const slots = await slotUrls(deps, job.user_id, payload);
  if (slots.length > 0) ctx.referenceUrls = slots;

  const parent = await parentVideo(deps, job.user_id, payload);
  if (parent?.url) ctx.parentVideoUrl = parent.url;
  if (parent?.interactionId) ctx.interactionId = parent.interactionId;

  return ctx;
}

function normalizedOf(payload: StoredPayload): NormalizedRequest {
  return {
    quoteVersion: payload.quoteVersion,
    catalogVersion: payload.catalogVersion,
    familyId: payload.familyId,
    op: payload.op,
    providerModel: payload.providerModel,
    providerSettings: payload.providerSettings as NormalizedRequest['providerSettings'],
    settings: payload.settings,
    hasReference: !!payload.referenceUploadId || !!payload.parentId || !!payload.personaId,
    hasMask: !!payload.maskUploadId,
  };
}

// ---------------------------------------------------------------- references

async function referenceUrl(
  deps: PayloadDeps,
  userId: string,
  payload: StoredPayload,
): Promise<string | null> {
  if (payload.referenceUploadId) {
    return await signUpload(deps, userId, payload.referenceUploadId);
  }
  // A video parent is a different thing (parentVideoUrl); only an image parent
  // is a reference image.
  if (!payload.parentId || payload.mode) return null;
  const parent = await ownedGeneration(deps, userId, payload.parentId);
  if (parent.kind !== 'image') throw new Error('parent_not_image');
  return await signStored(deps, parent.storage_backend, parent.media_path);
}

/**
 * The persona's five photos, signed for this run, in the order the prompt
 * names them. Re-checked here: the persona may have been deleted, or lost a
 * photo, while the job queued — that must fail before a provider call.
 */
async function personaPhotos(
  deps: PayloadDeps,
  userId: string,
  payload: StoredPayload,
): Promise<{ slot: string; url: string }[]> {
  if (!payload.personaId) return [];
  const { data, error } = await deps.admin
    .from('personas')
    .select('status,photos')
    .eq('id', payload.personaId)
    .eq('user_id', userId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw new Error(`persona_lookup_failed: ${error.message}`);
  if (!data || data.status !== 'ready') throw new Error('persona_unavailable');
  const photos = (data.photos ?? {}) as Record<string, string | null>;
  const signed: { slot: string; url: string }[] = [];
  for (const slot of PERSONA_SLOT_ORDER) {
    const path = photos[slot];
    if (!path) throw new Error('persona_unavailable');
    signed.push({ slot, url: await signUpload(deps, userId, path, 'persona-photo') });
  }
  return signed;
}

async function slotUrls(
  deps: PayloadDeps,
  userId: string,
  payload: StoredPayload,
): Promise<string[]> {
  const slots = payload.referenceSlots;
  if (!slots) return [];
  // Keyframes are positional: [first, last]. Reordering them is a different
  // video, so the order is part of the payload, not of a set.
  const ordered = slots.first || slots.last
    ? [slots.first, slots.last].filter((p): p is string => !!p)
    : (slots.references ?? []);
  const urls: string[] = [];
  for (const path of ordered) {
    urls.push(await signUpload(deps, userId, path));
  }
  return urls;
}

async function parentVideo(
  deps: PayloadDeps,
  userId: string,
  payload: StoredPayload,
): Promise<{ url: string; interactionId?: string } | null> {
  if (!payload.parentId || !payload.mode) return null;
  const parent = await ownedGeneration(deps, userId, payload.parentId);
  if (parent.kind !== 'video') throw new Error('parent_not_video');
  const url = await signStored(deps, parent.storage_backend, parent.media_path);
  const interactionId = (parent.settings as Record<string, unknown> | null)
    ?.interactionId as string | undefined;
  return { url, interactionId };
}

async function maskBase64(
  deps: PayloadDeps,
  userId: string,
  payload: StoredPayload,
): Promise<string | null> {
  if (!payload.maskUploadId) return null;
  const owned = await resolveOwnedUpload(deps.admin, userId, payload.maskUploadId, 'mask');
  if (typeof owned === 'string') throw new Error(`mask_${owned}`);
  const { data, error } = await deps.admin.storage.from('uploads').download(owned.path);
  if (error || !data) throw new Error('mask_unavailable');
  return encodeBase64(new Uint8Array(await data.arrayBuffer()));
}

// ------------------------------------------------------------------ plumbing

async function signUpload(
  deps: PayloadDeps,
  userId: string,
  path: string,
  purpose: UploadPurpose = 'reference',
): Promise<string> {
  const owned = await resolveOwnedUpload(deps.admin, userId, path, purpose);
  if (typeof owned === 'string') throw new Error(`reference_${owned}`);
  const { data, error } = await deps.admin.storage
    .from('uploads')
    .createSignedUrl(owned.path, deps.signTtlS ?? DEFAULT_TTL_S);
  if (error || !data?.signedUrl) throw new Error('reference_unavailable');
  return data.signedUrl;
}

interface OwnedGeneration {
  kind: string;
  media_path: string | null;
  storage_backend: StorageBackend;
  settings: unknown;
}

async function ownedGeneration(
  deps: PayloadDeps,
  userId: string,
  id: string,
): Promise<OwnedGeneration> {
  const { data, error } = await deps.admin
    .from('generations')
    .select('kind,status,media_path,storage_backend,settings')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(`parent_lookup_failed: ${error.message}`);
  if (!data) throw new Error('parent_not_found');
  if (data.status !== 'done' || !data.media_path) throw new Error('parent_not_ready');
  return {
    kind: String(data.kind),
    media_path: String(data.media_path),
    storage_backend: (data.storage_backend as StorageBackend) ?? 'supabase',
    settings: data.settings,
  };
}

async function signStored(
  deps: PayloadDeps,
  backend: StorageBackend,
  path: string | null,
): Promise<string> {
  if (!path) throw new Error('parent_not_ready');
  const ttl = deps.signTtlS ?? DEFAULT_TTL_S;
  if (backend === 'r2') return await deps.storageFor('r2').signedUrl(path, ttl);
  const { data, error } = await deps.admin.storage
    .from('media')
    .createSignedUrl(path, ttl);
  if (error || !data?.signedUrl) throw new Error('parent_unavailable');
  return data.signedUrl;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
