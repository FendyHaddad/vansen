import { Injectable, InjectionToken, inject } from '@angular/core';
import { environment } from '../../../environments/environment';

/**
 * What the deployed system has been VERIFIED to do — not what the code can do.
 *
 * The two flags here are promises made to a customer in the UI, and a promise
 * the deployment cannot keep is worse than no promise: "you can close this"
 * with no worker running means the render never finishes, and "we'll notify
 * you" with no verified delivery means it finishes in silence. P9 sets these
 * from its release manifest after the rehearsal passes; until then they are
 * absent, which reads as false.
 */
export interface ReleaseCapabilityManifest {
  /** A deployed worker finishes work after every client has gone away. */
  backgroundCompletion?: boolean;
  /** Completion notifications are delivered AND deduplicated on the device. */
  completionNotifications?: boolean;
}

export const RELEASE_CAPABILITIES = new InjectionToken<ReleaseCapabilityManifest | null>(
  'RELEASE_CAPABILITIES',
  {
    providedIn: 'root',
    factory: () =>
      (environment as { releaseCapabilities?: ReleaseCapabilityManifest })
        .releaseCapabilities ?? null,
  },
);

@Injectable({ providedIn: 'root' })
export class ReleaseCapabilities {
  private readonly manifest = inject(RELEASE_CAPABILITIES, { optional: true });

  /** Unreadable, unreachable or unset manifests all mean "not verified". */
  backgroundCompletion(): boolean {
    return this.manifest?.backgroundCompletion === true;
  }

  /**
   * Notification wording needs both halves: work that completes with no client
   * attached, and a delivery path proven on the device.
   */
  completionNotifications(): boolean {
    return this.backgroundCompletion() && this.manifest?.completionNotifications === true;
  }
}
