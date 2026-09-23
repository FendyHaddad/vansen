// Workspace-page notice banner, suspension flag and the polite live-region
// announcer, moved out of WorkspacePage verbatim. Also home to the pure
// helpers the banner text is built from: `modelDisabledNotice` and
// `announcementFor`. Component-scoped (see `WorkspacePage`'s `providers`) so
// a fresh `WorkspaceNotices` instance is created with each page.
import { Injectable, effect, inject, signal } from '@angular/core';
import { ApiError } from '../../core/api/api-service';
import { GenerationStore, type GenerationItem } from '../../core/generations/generation-store';
import { NotificationStore } from '../../core/notifications/notification-store';

/** Synchronous video-submit / cancel error codes → verbatim notice copy. */
const VIDEO_ERROR_COPY: Record<string, string> = {
  provider_blocked: 'Provider declined this prompt. Credits refunded.',
  too_many_jobs: '3 videos are still rendering — wait for one to finish',
  unsupported_mode: "This model can't do that mode.",
  bad_parent: 'Pick a finished video to extend or edit.',
  not_cancellable: "This model can't be cancelled once started.",
  bad_reference_count: 'Add the reference images this mode needs.',
};

/** The model_disabled notice. A persona run has no other model to try. */
export function modelDisabledNotice(personaRun: boolean): string {
  if (personaRun) return 'Personas are temporarily unavailable.';
  return 'That model is temporarily unavailable. Try another.';
}

/**
 * Plain words for what just happened, for the polite live region.
 *
 * Deliberately short and countable: a screen reader reads this aloud over
 * whatever the person is doing, so it says what changed and stops.
 */
export function announcementFor(changed: GenerationItem[]): string {
  const done = changed.filter((i) => i.status === 'done').length;
  const failed = changed.filter((i) => i.status === 'failed');
  const cancelled = failed.filter((i) => i.failure?.cancelled).length;
  const broken = failed.length - cancelled;

  const parts: string[] = [];
  if (done) parts.push(`${done} ${done === 1 ? 'generation is' : 'generations are'} ready`);
  // "Failed" alone leaves the obvious question unanswered, and the refund is
  // the part that decides whether to try again.
  if (broken) {
    parts.push(
      `${broken} ${broken === 1 ? 'generation' : 'generations'} failed and ${broken === 1 ? 'was' : 'were'} refunded`,
    );
  }
  if (cancelled) parts.push(`${cancelled} cancelled and refunded`);
  return parts.join('. ');
}

@Injectable()
export class WorkspaceNotices {
  private readonly store = inject(GenerationStore);
  private readonly notifications = inject(NotificationStore);

  /** Inline notice banner (errors, phase hints). */
  readonly notice = signal('');

  /** Set when 2 strikes suspend the account — blocks the whole workspace. */
  readonly suspended = signal(false);

  /**
   * Spoken, not shown.
   *
   * A generation finishing rewrites a tile in the grid with nothing to mark
   * the change, so a screen-reader user had no way to know a render they had
   * been waiting on was done, refunded or lost. This is read out politely, on
   * its own, without moving focus.
   */
  readonly liveMessage = signal('');

  /** Statuses as of the last announcement, so only changes are spoken. */
  private readonly lastStatus = new Map<string, string>();

  /** The library's first settle is history, not news. */
  private announcedOnce = false;

  constructor() {
    // Speak completions, failures and refunds as they land.
    effect(() => {
      const settled = this.store.items().filter((i) => i.status !== 'pending');
      const changed = settled.filter((i) => this.lastStatus.get(i.id) !== i.status);
      for (const item of settled) this.lastStatus.set(item.id, item.status);
      // First load settles the whole library at once; announcing all of it
      // would read the page aloud to someone who just arrived.
      if (!this.announcedOnce) {
        this.announcedOnce = true;
        return;
      }
      if (changed.length === 0) return;
      this.liveMessage.set(announcementFor(changed));
    });
  }

  showError(e: unknown, fallback: string, personaRun = false): void {
    if (!(e instanceof ApiError)) {
      this.notice.set(fallback);
      return;
    }
    if (e.code === 'insufficient_credits') {
      this.notice.set('Not enough credits — top up with “Add credits” in the top bar.');
      return;
    }
    if (e.code === 'subscription_required') {
      this.notice.set('An active subscription is required — pick a plan to start creating.');
      return;
    }
    if (e.code === 'pro_required') {
      this.notice.set('That model needs the Pro plan — upgrade from Settings → Subscription.');
      return;
    }
    if (e.code === 'account_suspended') {
      this.suspended.set(true);
      return;
    }
    if (e.code === 'content_policy') {
      this.notice.set(
        'This request violates our content policy and was blocked. Two violations suspend your account. If this was a mistake, contact support to appeal.',
      );
      this.notifications.add({
        kind: 'blocked',
        title: 'Blocked by moderation',
        detail: 'The request violated the content policy — nothing was charged.',
      });
      return;
    }
    if (e.code === 'model_disabled') {
      this.notice.set(modelDisabledNotice(personaRun));
      return;
    }
    if (e.code === 'daily_cap') {
      const parsed = Date.parse(String(e.details['resetsAt'] ?? ''));
      const h = Number.isFinite(parsed) ? Math.max(1, Math.ceil((parsed - Date.now()) / 3_600_000)) : 24;
      this.notice.set(`Daily video limit reached, resets in ${h}h`);
      return;
    }
    if (VIDEO_ERROR_COPY[e.code]) {
      this.notice.set(VIDEO_ERROR_COPY[e.code]);
      return;
    }
    this.notice.set(e.message);
  }
}
