import { Injectable, signal } from '@angular/core';

/** Anything holding per-account state. Stores register themselves. */
export interface Resettable {
  reset(): void | Promise<void>;
}

/**
 * One place that knows "the person using this browser changed".
 *
 * Teardown used to live inside WorkspacePage.signOut(), so it only ran when
 * someone clicked Sign out on that page. A token expiry, a revoked session, or
 * a sign-out performed in another tab left every store holding the previous
 * account's library, balance and notifications — and the next account to sign
 * in on the same browser inherited them.
 *
 * The epoch is the second half: work started under one identity carries the
 * epoch it began with, and anything that comes back after a change is dropped
 * rather than written into the new account's state.
 */
@Injectable({ providedIn: 'root' })
export class SessionLifecycle {
  private readonly epochSig = signal(0);
  private readonly userSig = signal<string | null>(null);
  private readonly targets = new Map<string, Resettable>();
  private settled = false;

  readonly epoch = this.epochSig.asReadonly();
  readonly userId = this.userSig.asReadonly();

  register(name: string, target: Resettable): void {
    this.targets.set(name, target);
  }

  registeredNames(): string[] {
    return [...this.targets.keys()];
  }

  isCurrent(epoch: number): boolean {
    return epoch === this.epochSig();
  }

  async onIdentityChange(nextUserId: string | null): Promise<void> {
    const previous = this.userSig();
    this.userSig.set(nextUserId);

    // The first observation establishes who we are; it is not a change.
    if (!this.settled) {
      this.settled = true;
      return;
    }
    // A token refresh reports the same user. Wiping the library every hour
    // would make the app blink for no reason.
    if (previous === nextUserId) return;

    this.epochSig.update((n) => n + 1);
    await this.resetAll();
  }

  private async resetAll(): Promise<void> {
    for (const [name, target] of this.targets) {
      try {
        await target.reset();
      } catch (e) {
        // A half-finished teardown is the failure mode this class prevents,
        // so one bad store must not stop the rest.
        console.error('reset_failed', name, e);
      }
    }
  }
}
