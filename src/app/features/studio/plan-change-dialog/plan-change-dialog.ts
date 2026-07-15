import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  linkedSignal,
  output,
} from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCalendarClock,
  lucideCheck,
  lucideSparkles,
  lucideX,
  lucideZap,
} from '@ng-icons/lucide';
import { HlmButton } from '@spartan-ng/helm/button';
import { PLAN_CREDITS, PLAN_PRICE_USD } from '../../../core/catalog/model-families';

export type ChangeWhen = 'now' | 'period_end';

/**
 * Confirms a Studio <-> Pro switch before any money moves.
 *
 * Exists because the switch is not intuitive on its own: plan credits do not
 * carry across (fn_cycle_reset SETS the balance to the new grant), so someone
 * upgrading mid-cycle silently loses whatever Studio credits they had left.
 * The dialog says that in words before they commit, and doubles as the reminder
 * for a change booked at renewal.
 */
@Component({
  selector: 'app-plan-change-dialog',
  templateUrl: './plan-change-dialog.html',
  styleUrl: './plan-change-dialog.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, DecimalPipe, NgIcon, HlmButton],
  providers: [
    provideIcons({ lucideCalendarClock, lucideCheck, lucideSparkles, lucideX, lucideZap }),
  ],
})
export class PlanChangeDialog {
  /** Plan being moved to. */
  readonly target = input.required<'studio' | 'pro'>();
  /** Plan they are on now — decides upgrade vs downgrade copy and options. */
  readonly current = input.required<'studio' | 'pro'>();
  /** Renewal date, when a scheduled change would land. */
  readonly periodEnd = input<string | null>(null);
  /** Plan credits they hold right now — the number they stand to lose. */
  readonly planCredits = input(0);
  readonly busy = input(false);
  /** Change already booked at renewal, if any — flips the dialog into
   * "scheduled" mode so it cannot book the same change twice. */
  readonly pendingPlan = input<'studio' | 'pro' | null>(null);
  /** Server rejection to show inside the dialog — a banner behind the backdrop
   * is invisible, which is how "the button did nothing" reports happen. */
  readonly error = input('');

  readonly confirmed = output<ChangeWhen>();
  readonly dismissed = output<void>();

  readonly upgrading = computed(() => this.current() === 'studio' && this.target() === 'pro');
  readonly targetLabel = computed(() => (this.target() === 'pro' ? 'Pro' : 'Studio'));
  readonly currentLabel = computed(() => (this.current() === 'pro' ? 'Pro' : 'Studio'));
  readonly targetPrice = computed(() => PLAN_PRICE_USD[this.target()]);
  readonly targetCredits = computed(() => PLAN_CREDITS[this.target()]);

  /**
   * Downgrades are period_end only — an immediate one would make the server's
   * cycle reset compute a negative delta and delete paid-for credits. The API
   * rejects it too; this just keeps the choice off the screen.
   */
  readonly canSwitchNow = computed(() => this.upgrading());

  /** This exact change is already booked — the renewal option is spent. */
  readonly alreadyScheduled = computed(() => this.pendingPlan() === this.target());

  /** Scheduled downgrade: nothing left to confirm, the dialog just says so. */
  readonly scheduledOnly = computed(() => this.alreadyScheduled() && !this.canSwitchNow());

  /** Default to the option that moves no money — unless renewal is already
   * booked, where "start now instead" is the only choice left. */
  readonly when = linkedSignal<ChangeWhen>(() =>
    this.alreadyScheduled() && this.canSwitchNow() ? 'now' : 'period_end',
  );

  /** Credits at risk: only an immediate switch resets the balance mid-cycle. */
  readonly creditsLost = computed(() =>
    this.when() === 'now' && this.planCredits() > 0 ? this.planCredits() : 0,
  );

  choose(when: ChangeWhen): void {
    if (when === 'now' && !this.canSwitchNow()) return;
    if (when === 'period_end' && this.alreadyScheduled()) return;
    this.when.set(when);
  }

  /** Dismissal is off while a request is in flight — closing mid-flight leaves
   * the user unsure whether the change happened. */
  close(): void {
    if (this.busy()) return;
    this.dismissed.emit();
  }

  confirm(): void {
    if (this.busy()) return;
    if (this.when() === 'period_end' && this.alreadyScheduled()) return;
    this.confirmed.emit(this.when());
  }
}
