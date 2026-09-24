import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideChevronLeft, lucideChevronRight } from '@ng-icons/lucide';
import { TREND_PRESETS, TrendPreset } from '../../../core/catalog/trend-presets';
import { Hint } from '../../../shared/hint/hint';

/** Tiles moved per arrow click. */
const PAGE_TILES = 2;

/**
 * Trends as a sideways carousel under the prompt: swipe with a trackpad, or
 * use the edge arrows with a mouse. A tile grows on hover so the look is easy
 * to judge; picking one fills the prompt.
 */
@Component({
  selector: 'app-trend-gallery',
  templateUrl: './trend-gallery.html',
  styleUrl: './trend-gallery.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgIcon, Hint],
  providers: [provideIcons({ lucideChevronLeft, lucideChevronRight })],
})
export class TrendGallery {
  /** Id of the trend the prompt came from, highlighted in the strip. */
  readonly selected = input<string | null>(null);
  readonly picked = output<TrendPreset>();
  readonly trends = TREND_PRESETS;

  readonly atStart = signal(true);
  readonly atEnd = signal(false);

  private readonly track = viewChild<ElementRef<HTMLElement>>('track');

  /**
   * Thumbnails that did not load.
   *
   * `scripts/check-assets.mjs` is the gate that stops a missing one shipping;
   * this is what a customer sees if one goes missing anyway. A named tile is
   * still pickable — a broken-image icon just looks like the app is broken.
   */
  readonly missing = signal<ReadonlySet<string>>(new Set());

  constructor() {
    afterNextRender(() => this.onScroll());
  }

  markMissing(id: string): void {
    this.missing.update((set) => new Set(set).add(id));
  }

  pick(trend: TrendPreset): void {
    this.picked.emit(trend);
  }

  onScroll(): void {
    const el = this.track()?.nativeElement;
    if (!el) return;
    this.atStart.set(el.scrollLeft <= 1);
    this.atEnd.set(el.scrollLeft + el.clientWidth >= el.scrollWidth - 1);
  }

  page(direction: 1 | -1): void {
    const el = this.track()?.nativeElement;
    const tile = el?.querySelector<HTMLElement>('.tc-tile');
    if (!el || !tile) return;
    const step = (tile.offsetWidth + parseFloat(getComputedStyle(el).columnGap || '0')) * PAGE_TILES;
    el.scrollBy({ left: direction * step, behavior: 'smooth' });
  }
}
