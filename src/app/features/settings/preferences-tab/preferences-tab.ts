import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { HlmLabel } from '@spartan-ng/helm/label';
import { PreferencesService } from '../../../core/preferences/preferences-service';
import { MODEL_FAMILIES } from '../../../core/catalog/model-families';

@Component({
  selector: 'app-preferences-tab',
  templateUrl: './preferences-tab.html',
  styleUrl: './preferences-tab.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmLabel],
})
export class PreferencesTab {
  private readonly prefsService = inject(PreferencesService);

  readonly prefs = this.prefsService.prefs;
  readonly imageFamilies = MODEL_FAMILIES.filter((f) => f.kind === 'image');
  readonly videoFamilies = MODEL_FAMILIES.filter((f) => f.kind === 'video');
  readonly aspects = ['1:1', '3:4', '4:3', '16:9', '9:16'];

  setMode(value: string): void {
    this.prefsService.update({ defaultMode: value === 'video' ? 'video' : 'image' });
  }

  setImageFamily(value: string): void {
    this.prefsService.update({ defaultImageFamily: value });
  }

  setVideoFamily(value: string): void {
    this.prefsService.update({ defaultVideoFamily: value });
  }

  setAspect(value: string): void {
    this.prefsService.update({ defaultAspect: value });
  }

  setThreshold(value: string): void {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) {
      this.prefsService.update({ confirmOverUsd: parsed });
    }
  }
}
