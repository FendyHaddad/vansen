import { ChangeDetectionStrategy, Component, output } from '@angular/core';
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

  pick(trend: TrendPreset): void {
    this.picked.emit(trend);
  }
}
