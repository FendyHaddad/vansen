// What an anonymous visitor is allowed to know about this deployment.
//
// The pricing page, the landing page and the login splash all advertise
// models. They were hand-written lists, so they named models the deployment
// had never enabled (and one, Sora, that has no adapter at all). A visitor
// bought a plan for a model that was not there.
//
// This is a WHITELIST, not a projection of a row. Nothing about a user, an
// entitlement, a price id or a provider may pass through it — the response is
// served before the auth middleware, so there is nobody to authorise.
import { CATALOG_VERSION } from '../_shared/model-families.ts';

export interface PublicCapabilities {
  /** Families with `models.enabled = true`. Never advertise anything else. */
  enabledFamilyIds: string[];
  /** A deployed worker finishes work after every client has gone away. */
  backgroundCompletion: boolean;
  /** Completion notifications are delivered AND deduplicated on the device. */
  completionNotifications: boolean;
  /** Lets a stale client notice its catalog no longer matches the server's. */
  catalogVersion: string;
}

/** Release flags the deployment owns, so P9 can flip one without a rebuild. */
export interface ReleaseFlags {
  backgroundCompletion: boolean;
  completionNotifications: boolean;
}

export function releaseFlagsFromEnv(get: (k: string) => string | undefined): ReleaseFlags {
  // Anything other than the exact string "on" is off. A typo in a dashboard
  // must not turn into a promise the deployment cannot keep.
  const background = get('RELEASE_BACKGROUND_COMPLETION') === 'on';
  return {
    backgroundCompletion: background,
    // Notifications need both halves: work that finishes with no client
    // attached, and a delivery path proven on the device.
    completionNotifications: background && get('RELEASE_COMPLETION_NOTIFICATIONS') === 'on',
  };
}

export function publicCapabilities(
  rows: { id: unknown; enabled: unknown }[] | null,
  flags: ReleaseFlags,
): PublicCapabilities {
  const enabledFamilyIds = (rows ?? [])
    .filter((r) => r.enabled === true && typeof r.id === 'string' && r.id.length > 0)
    .map((r) => r.id as string)
    .sort();
  return {
    enabledFamilyIds,
    backgroundCompletion: flags.backgroundCompletion,
    completionNotifications: flags.backgroundCompletion && flags.completionNotifications,
    catalogVersion: CATALOG_VERSION,
  };
}
