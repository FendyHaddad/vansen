// Video request preparation for submitGeneration.
// resolveVideoPrep() returns null for a non-video request, a Response on
// refusal, or the mode, owned + moderated references and parent video.
// Caps are enforced by fn_reserve_generation, not here.
import type { Context } from "jsr:@hono/hono";
import {
  familyById,
  type GenerationSettings,
  type ModelFamily,
  videoFamilySupports,
  type VideoMode,
} from "../_shared/model-families.ts";
import { MediaKind } from "../_shared/enums.ts";
import type { StoredPayload } from "../_shared/jobs/payload.ts";
import type { StorageBackend } from "../_shared/storage/index.ts";
import { resolveOwnedUpload } from "../_shared/reference-resolver.ts";
import { referenceRule } from "../_shared/video-rules.ts";
import type { Services } from "../lib/context.ts";
import { fail } from "../lib/http.ts";

export const REF_SIGN_TTL_S = 3600;
const UPLOAD_PATH = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(png|jpg|jpeg|webp)$/i;

export interface VideoPrep {
  mode: VideoMode;
  referencePaths: string[];
  referenceUrls: string[];
  parentVideoUrl?: string;
  interactionId?: string;
}

/** Video reference slots, keeping first/last positional order. */
export function slotsOf(video: VideoPrep): StoredPayload["referenceSlots"] {
  if (video.mode === "keyframes") {
    return { first: video.referencePaths[0], last: video.referencePaths[1] };
  }
  return { references: [...video.referencePaths] };
}

export function createVideoPrep(
  ctx: Pick<
    Services,
    | "admin"
    | "moderate"
    | "signStored"
    | "referenceFailure"
    | "moderationFailure"
    | "recordStrike"
  >,
) {
  const {
    admin,
    moderate,
    signStored,
    referenceFailure,
    moderationFailure,
    recordStrike,
  } = ctx;

  /** Resolves the parent video for extend/edit modes (a no-op for modes that don't
   * need one). Guard clauses only — flattened out of `prepareVideo` so the
   * `rule.needsParent` check never wraps another `if`. */
  async function resolveParentVideo(
    userId: string,
    family: ModelFamily,
    parentId: string | null,
    needsParent: boolean,
  ): Promise<
    { parentVideoUrl?: string; interactionId?: string } | "bad_parent" | null
  > {
    if (!needsParent) return null;
    if (!parentId) return "bad_parent";
    const { data: parent } = await admin
      .from("generations")
      .select("id,kind,status,media_path,storage_backend,settings,family_id")
      .eq("id", parentId)
      .eq("user_id", userId)
      .is("deleted_at", null)
      .maybeSingle();
    const usable = parent && parent.kind === MediaKind.Video &&
      parent.status === "done" && parent.media_path;
    if (!usable) return "bad_parent";
    // Veo can only continue its own clips — it takes the parent as inline media it
    // generated, not an arbitrary MP4.
    if (family.id === "veo" && parent.family_id !== "veo") return "bad_parent";
    const parentVideoUrl = await signStored(
      parent.storage_backend as StorageBackend,
      parent.media_path,
      REF_SIGN_TTL_S,
    );
    const parentInteraction = (parent.settings as GenerationSettings | null)
      ?.interactionId;
    const omniContinuation = family.id === "omni" &&
      parent.family_id === "omni" && !!parentInteraction;
    return {
      parentVideoUrl,
      interactionId: omniContinuation ? parentInteraction : undefined,
    };
  }

  /** Validates + prepares a video request. Returns a Response on rejection. */
  async function prepareVideo(
    c: Context,
    userId: string,
    family: ModelFamily,
    settings: GenerationSettings,
    body: Record<string, unknown>,
    parentId: string | null,
  ): Promise<VideoPrep | Response> {
    const mode = settings.mode ?? "t2v";
    if (!videoFamilySupports(family, mode)) {
      return fail(c, 400, "unsupported_mode", "This model can't do that mode.");
    }
    const rule = referenceRule(mode);
    const rawRefs = Array.isArray(body.referencePaths)
      ? body.referencePaths
      : [];
    const referencePaths = rawRefs.filter((p): p is string =>
      typeof p === "string" && UPLOAD_PATH.test(p)
    );
    if (
      referencePaths.length !== rawRefs.length ||
      referencePaths.length < rule.min || referencePaths.length > rule.max
    ) {
      return fail(
        c,
        400,
        "bad_reference_count",
        `${mode} needs ${rule.min}–${rule.max} reference image(s).`,
      );
    }
    for (const path of referencePaths) {
      const owned = await resolveOwnedUpload(admin, userId, path, "reference");
      if (typeof owned === "string") return referenceFailure(c, owned);
    }

    const prep: VideoPrep = { mode, referencePaths, referenceUrls: [] };

    const parentResult = await resolveParentVideo(
      userId,
      family,
      parentId,
      rule.needsParent,
    );
    if (parentResult === "bad_parent") {
      return fail(
        c,
        400,
        "bad_parent",
        "Pick a finished video to extend or edit.",
      );
    }
    if (parentResult) Object.assign(prep, parentResult);

    // Caps are NOT checked here any more. A select before the charge is a
    // suggestion, not a limit — four simultaneous submissions all passed it.
    // `fn_reserve_generation` enforces pending count and daily spend inside the
    // charging transaction.

    for (const path of referencePaths) {
      const { data: signed, error } = await admin.storage.from("uploads")
        .createSignedUrl(path, REF_SIGN_TTL_S);
      if (error || !signed) {
        return fail(
          c,
          400,
          "bad_reference_count",
          "Reference upload not found.",
        );
      }
      const decision = await moderate({ imageUrl: signed.signedUrl });
      if (decision.state === "unavailable") {
        return moderationFailure(c, decision);
      }
      if (decision.state === "blocked") {
        await recordStrike(userId, "upload", null, decision.categories, path);
        return fail(
          c,
          422,
          "content_policy",
          "A reference image was blocked by moderation.",
        );
      }
      prep.referenceUrls.push(signed.signedUrl);
    }
    return prep;
  }

  /** Guard-clause wrapper so the `kind === Video` branch never wraps another
   * `if` in the handler: non-video requests short-circuit to `null` here. */
  async function resolveVideoPrep(
    c: Context,
    userId: string,
    kind: string,
    familyId: string,
    settings: GenerationSettings,
    body: Record<string, unknown>,
    parentId: string | null,
  ): Promise<VideoPrep | Response | null> {
    if (kind !== MediaKind.Video) return null;
    const family = familyById(familyId)!;
    return prepareVideo(c, userId, family, settings, body, parentId);
  }

  return { resolveVideoPrep };
}
