import { ChangeDetectionStrategy, Component, output, signal } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideChevronDown, lucideFlame } from '@ng-icons/lucide';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { TREND_PRESETS, TrendPreset } from '../../../core/catalog/trend-presets';
import { Hint } from '../../../shared/hint/hint';

@Component({
  selector: 'app-trend-gallery',
  templateUrl: './trend-gallery.html',
  styleUrl: './trend-gallery.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgIcon, Hint, ...HlmDropdownMenuImports],
  providers: [provideIcons({ lucideChevronDown, lucideFlame })],
})
export class TrendGallery {
  readonly picked = output<TrendPreset>();
  readonly trends = TREND_PRESETS;

  /**
   * Thumbnails that did not load.
   *
   * `scripts/check-assets.mjs` is the gate that stops a missing one shipping;
   * this is what a customer sees if one goes missing anyway. A named tile is
   * still pickable — a broken-image icon just looks like the app is broken.
   */
  readonly missing = signal<ReadonlySet<string>>(new Set());

  markMissing(id: string): void {
    this.missing.update((set) => new Set(set).add(id));
  }

  pick(trend: TrendPreset): void {
    this.picked.emit(trend);
  }
}
