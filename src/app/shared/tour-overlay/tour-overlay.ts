import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { Router } from '@angular/router';
import { TourService } from '../../core/tour/tour-service';

interface SpotRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

const SPOT_PAD = 8;
const CARD_GAP = 16;
const CARD_WIDTH = 336;
const CARD_EST_HEIGHT = 300;
const EDGE = 16;

@Component({
  selector: 'app-tour-overlay',
  templateUrl: './tour-overlay.html',
  styleUrl: './tour-overlay.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TourOverlay {
  readonly tour = inject(TourService);
  private readonly router = inject(Router);

  /** Subscribe-step CTA: close the tour and open the plans page. */
  seePlans(): void {
    this.tour.finish();
    void this.router.navigate(['/pricing']);
  }

  private readonly card = viewChild<ElementRef<HTMLElement>>('card');

  /** Spotlight rect in viewport px; null = centered step (welcome). */
  readonly rect = signal<SpotRect | null>(null);

  readonly stepNumber = computed(() => this.tour.activeIndex() + 1);
  readonly total = computed(() => this.tour.visibleSteps().length);

  /** Inline geometry — the one allowed [style] exception (computed rects). */
  readonly spotStyle = computed(() => {
    const r = this.rect();
    if (!r) return null;
    return {
      top: `${r.top - SPOT_PAD}px`,
      left: `${r.left - SPOT_PAD}px`,
      width: `${r.width + SPOT_PAD * 2}px`,
      height: `${r.height + SPOT_PAD * 2}px`,
    };
  });

  readonly cardStyle = computed(() => {
    const r = this.rect();
    if (!r) return null;
    let top: number;
    let left: number;
    switch (this.tour.current().placement) {
      case 'right':
        top = r.top;
        left = r.left + r.width + SPOT_PAD + CARD_GAP;
        break;
      case 'left':
        top = r.top;
        left = r.left - SPOT_PAD - CARD_GAP - CARD_WIDTH;
        break;
      case 'top':
        top = r.top - SPOT_PAD - CARD_GAP - CARD_EST_HEIGHT;
        left = r.left + r.width / 2 - CARD_WIDTH / 2;
        break;
      default:
        top = r.top + r.height + SPOT_PAD + CARD_GAP;
        left = r.left + r.width / 2 - CARD_WIDTH / 2;
    }
    top = Math.max(EDGE, Math.min(top, window.innerHeight - CARD_EST_HEIGHT - EDGE));
    left = Math.max(EDGE, Math.min(left, window.innerWidth - CARD_WIDTH - EDGE));
    return { top: `${top}px`, left: `${left}px` };
  });

  constructor() {
    const remeasure = () => this.measure();
    const onKey = (e: KeyboardEvent) => this.onKeydown(e);
    window.addEventListener('resize', remeasure);
    window.addEventListener('scroll', remeasure, true);
    document.addEventListener('keydown', onKey);
    inject(DestroyRef).onDestroy(() => {
      window.removeEventListener('resize', remeasure);
      window.removeEventListener('scroll', remeasure, true);
      document.removeEventListener('keydown', onKey);
    });

    // Re-measure on each step; focus the card so keyboard nav lands there.
    effect(() => {
      this.tour.activeIndex();
      this.measure();
      queueMicrotask(() => this.card()?.nativeElement.focus());
    });
  }

  private measure(): void {
    if (!this.tour.active()) return;
    const step = this.tour.current();
    if (!step.target) {
      this.rect.set(null);
      return;
    }
    const el = document.querySelector(`[data-tour="${step.target}"]`);
    if (!el) {
      // Target not on screen (feature hidden) — move on to the next step.
      this.tour.next();
      return;
    }
    const r = el.getBoundingClientRect();
    this.rect.set({ top: r.top, left: r.left, width: r.width, height: r.height });
  }

  private onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') this.tour.skip();
    else if (e.key === 'ArrowRight' || e.key === 'Enter') this.tour.next();
    else if (e.key === 'ArrowLeft') this.tour.prev();
  }
}
