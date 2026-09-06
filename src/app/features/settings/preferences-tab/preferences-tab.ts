import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { HlmLabel } from '@spartan-ng/helm/label';
import { PreferencesService } from '../../../core/preferences/preferences-service';
import { MODEL_FAMILIES } from '../../../core/catalog/model-families';
import type { VideoMode } from '../../../core/catalog/model-families';
import { MODE_LABELS } from '../../workspace/left-panel/mode-picker/mode-picker';

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
  readonly videoModes = Object.entries(MODE_LABELS) as [VideoMode, string][];

  setMode(value: string): void {
    this.prefsService.update({ defaultMode: value === 'video' ? 'video' : 'image' });
  }

  setImageFamily(value: string): void {
    this.prefsService.update({ defaultImageFamily: value });
  }

  setVideoFamily(value: string): void {
    this.prefsService.update({ defaultVideoFamily: value });
  }

  setVideoMode(v: string): void {
    this.prefsService.update({ defaultVideoMode: v as VideoMode });
  }

  setAspect(value: string): void {
    this.prefsService.update({ defaultAspect: value });
  }

}
