// Persona helpers for the api gateway: the slot vocabulary and the DTO.
// A persona is five guided photos; see
// docs/superpowers/specs/2026-09-23-persona-references-design.md.
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { PERSONA_SLOT_ORDER, type PersonaSlot } from "../_shared/model-families.ts";
import type { ReferenceError } from "../_shared/reference-resolver.ts";

export function isPersonaSlot(value: string): value is PersonaSlot {
  return (PERSONA_SLOT_ORDER as readonly string[]).includes(value);
}

export interface PersonaPhotoDto {
  slot: PersonaSlot;
  url: string | null;
}

export interface PersonaDto {
  id: string;
  name: string;
  status: "draft" | "ready";
  photos: PersonaPhotoDto[];
  thumbUrl: string;
  createdAt: string;
}

/** The persona's photo paths in slot order; null for an empty slot. */
export function personaPhotoPaths(row: Record<string, unknown>): (string | null)[] {
  const photos = (row.photos ?? {}) as Record<string, string | null>;
  return PERSONA_SLOT_ORDER.map((slot) => photos[slot] ?? null);
}

/**
 * A persona that can be generated with right now: this user's, not deleted,
 * ready, and with every slot filled. `"unavailable"` otherwise — the caller
 * answers `persona_unavailable` for all of those alike. A failed lookup is an
 * Error: that is ours, not the customer's persona.
 */
export async function readyPersona(
  admin: SupabaseClient,
  userId: string,
  personaId: string,
): Promise<{ paths: string[] } | "unavailable" | Error> {
  const { data, error } = await admin.from("personas")
    .select("status, photos")
    .eq("id", personaId).eq("user_id", userId).is("deleted_at", null)
    .maybeSingle();
  if (error) return new Error(`persona_lookup_failed: ${error.message}`);
  if (!data || data.status !== "ready") return "unavailable";
  const paths = personaPhotoPaths(data);
  if (!paths.every((p) => !!p)) return "unavailable";
  return { paths: paths as string[] };
}

/** The identity instruction Google's docs recommend: say what each image is. */
export function personaPrompt(userPrompt: string): string {
  return "Images 1–5 are the same person (front, left three-quarter, right three-quarter, " +
    "left profile, right profile). Keep their face and identity exactly. " + userPrompt;
}

export async function toPersonaDto(
  admin: SupabaseClient,
  browserUrl: (url: string) => string,
  row: Record<string, unknown>,
): Promise<PersonaDto> {
  const paths = personaPhotoPaths(row);
  const filled = paths.filter((p): p is string => !!p);
  // One round trip for every filled slot, not one per slot: a five-slot
  // persona used to sign up to five URLs one at a time.
  const signedByPath = new Map<string, string>();
  if (filled.length > 0) {
    const { data: signed } = await admin.storage.from("uploads").createSignedUrls(
      filled,
      3600,
    );
    for (const entry of signed ?? []) {
      if (entry.signedUrl && entry.path) signedByPath.set(entry.path, entry.signedUrl);
    }
  }
  // A filled slot always carries a string url, even '' on a signing failure
  // — only an EMPTY slot is null. A retry belongs to the signer, not to a
  // client treating a filled slot as if the photo were missing.
  const photos: PersonaPhotoDto[] = PERSONA_SLOT_ORDER.map((slot, i) => {
    const path = paths[i];
    if (!path) return { slot, url: null };
    return { slot, url: browserUrl(signedByPath.get(path) ?? "") };
  });
  return {
    id: String(row.id),
    name: String(row.name),
    status: row.status === "ready" ? "ready" : "draft",
    photos,
    thumbUrl: photos[0].url ?? "",
    createdAt: String(row.created_at),
  };
}

/** Persona-appropriate wording for a `resolveOwnedUpload` refusal. The code
 * stays `invalid_reference` — the same one `referenceFailure` uses for every
 * other reference — only the message changes to say "photo". */
const PERSONA_PHOTO_MESSAGES: Record<ReferenceError, string> = {
  not_found: "Photo not found — upload it again.",
  not_owned: "That photo does not belong to you.",
  not_moderated: "That photo has not finished its safety check.",
  wrong_purpose: "Upload this photo from the persona screen.",
};

export function personaPhotoFailure(
  err: ReferenceError,
): { status: number; message: string } {
  return { status: err === "not_found" ? 404 : 403, message: PERSONA_PHOTO_MESSAGES[err] };
}
