import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideX } from '@ng-icons/lucide';
import type { JobPhase } from '../../../core/api/dtos';
import type { GenerationItem } from '../../../core/generations/generation-store';

const EASE_CAP = 0.9;
const LATE_FACTOR = 2;

/** Ease-out toward 0.9 over expectedS; a real report ≥ eased value wins. */
export function easedProgress(elapsedS: number, expectedS: number, reported?: number): number {
  const t = Math.min(1, Math.max(0, elapsedS / Math.max(1, expectedS)));
  const eased = EASE_CAP * (1 - Math.pow(1 - t, 2.2));
  const rounded = Math.round(eased * 1000) / 1000;
  if (reported === undefined) return Math.min(EASE_CAP, rounded);
  return Math.max(rounded, Math.min(1, reported));
}

export function phaseLabel(phase: JobPhase | undefined, elapsedS: number, expectedS: number): string {
  if (phase === 'saving') return 'Saving';
  if (phase === 'queued') return 'Queued';
  if (elapsedS > expectedS * LATE_FACTOR) return 'Taking longer than usual — still working.';
  if (elapsedS > expectedS) return 'Almost there…';
  return 'Rendering';
}

@Component({
  selector: 'app-pending-video-card',
  imports: [NgIcon],
  providers: [provideIcons({ lucideX })],
  templateUrl: './pending-video-card.html',
  styleUrl: './pending-video-card.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PendingVideoCard {
  readonly item = input.required<GenerationItem>();
  readonly now = input.required<number>();
  readonly cancel = output<string>();

  private readonly job = computed(() => this.item().job);
  readonly elapsedS = computed(() => {
    const start = Date.parse(this.job()?.startedAt ?? this.item().createdAt);
    return Math.max(0, (this.now() - start) / 1000);
  });
  readonly expectedS = computed(() => this.job()?.expectedS ?? 60);
  readonly progress = computed(() => easedProgress(this.elapsedS(), this.expectedS(), this.job()?.progress));
  readonly percent = computed(() => Math.round(this.progress() * 100));
  readonly phase = computed(() => phaseLabel(this.job()?.phase, this.elapsedS(), this.expectedS()));
  readonly queueAhead = computed(() => {
    const q = this.job()?.queuePosition;
    if (this.job()?.phase !== 'queued' || q === undefined) return '';
    return ` · ${q} ahead`;
  });
  readonly cancellable = computed(() => this.job()?.cancellable ?? false);
  readonly eta = computed(() => {
    const left = Math.max(0, this.expectedS() - this.elapsedS());
    if (this.elapsedS() > this.expectedS()) return '';
    return `~${Math.ceil(left / 10) * 10}s`;
  });

  onCancel(ev: Event): void {
    ev.stopPropagation();
    this.cancel.emit(this.item().id);
  }
}
