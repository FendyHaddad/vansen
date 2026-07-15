import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  signal,
} from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCalendarClock, lucideCheck, lucideSparkles, lucideX } from '@ng-icons/lucide';
import { HlmButton } from '@spartan-ng/helm/button';

export interface CancelReason {
  code: string;
  label: string;
}

/** Why-are-you-leaving survey — one answer rides along to Stripe metadata. */
const REASONS: CancelReason[] = [
  { code: 'switching_tool', label: "I'm switching to another tool" },
  { code: 'missing_features', label: "It's missing features I need" },
  { code: 'too_hard', label: 'I found it too hard to use' },
  { code: 'one_time_project', label: 'I only needed it for a one-time project' },
  { code: 'technical_issues', label: 'Technical issues' },
  { code: 'too_expensive', label: "It's too expensive for what I'm getting" },
];

/**
 * Two-step cancellation with a confirmation screen: first what cancelling
 * costs (the value step), then the reason survey, then "you won't be billed
 * again". Pure dialog — the Subscription tab calls the API and drives
 * `busy` / `error` / `done`.
 */
@Component({
  selector: 'app-cancel-flow-dialog',
  templateUrl: './cancel-flow-dialog.html',
  styleUrl: './cancel-flow-dialog.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, DecimalPipe, NgIcon, HlmButton],
  providers: [provideIcons({ lucideCalendarClock, lucideCheck, lucideSparkles, lucideX })],
})
export class CancelFlowDialog {
  /** 'Studio' | 'Pro' — display only. */
  readonly planLabel = input.required<string>();
  readonly periodEnd = input<string | null>(null);
  readonly totalCredits = input(0);
  /** True while the cancel request is in flight. */
  readonly busy = input(false);
  /** Server rejection, rendered inside the dialog. */
  readonly error = input('');
  /** Parent flips this after the API confirms — shows the final screen. */
  readonly done = input(false);

  /** Emits the picked reason code once, on the survey's confirm. */
  readonly confirmed = output<string>();
  readonly dismissed = output<void>();

  readonly reasons = REASONS;
  readonly step = signal<'value' | 'reason'>('value');
  readonly reason = signal<string | null>(null);

  readonly daysLeft = computed(() => {
    const end = this.periodEnd();
    if (!end) return null;
    const left = Math.ceil((new Date(end).getTime() - Date.now()) / 86_400_000);
    return left > 0 ? left : null;
  });

  choose(code: string): void {
    if (this.busy()) return;
    this.reason.set(code);
  }

  /** Dismissal is off mid-flight — closing then leaves the outcome unknown. */
  close(): void {
    if (this.busy()) return;
    this.dismissed.emit();
  }

  confirm(): void {
    const code = this.reason();
    if (this.busy() || this.done() || !code) return;
    this.confirmed.emit(code);
  }
}
