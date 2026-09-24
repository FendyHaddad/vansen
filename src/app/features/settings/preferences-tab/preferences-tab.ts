import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { HlmLabel } from '@spartan-ng/helm/label';
import { PreferencesService } from '../../../core/preferences/preferences-service';
import type { Prefs } from '../../../core/preferences/preferences-service';
import { ToastService } from '../../../core/feedback/toast-service';
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
  private readonly toast = inject(ToastService);

  readonly prefs = this.prefsService.prefs;
  readonly imageFamilies = MODEL_FAMILIES.filter((f) => f.kind === 'image');
  readonly videoFamilies = MODEL_FAMILIES.filter((f) => f.kind === 'video');
  readonly aspects = ['1:1', '3:4', '4:3', '16:9', '9:16'];
  readonly videoModes = Object.entries(MODE_LABELS) as [VideoMode, string][];

  setMode(value: string): void {
    void this.save({ defaultMode: value === 'video' ? 'video' : 'image' });
  }

  setImageFamily(value: string): void {
    void this.save({ defaultImageFamily: value });
  }

  setVideoFamily(value: string): void {
    void this.save({ defaultVideoFamily: value });
  }

  setVideoMode(v: string): void {
    void this.save({ defaultVideoMode: v as VideoMode });
  }

  setAspect(value: string): void {
    void this.save({ defaultAspect: value });
  }

  /** Every select saves on change, so each change confirms itself. */
  private async save(patch: Partial<Prefs>): Promise<void> {
    try {
      await this.prefsService.update(patch);
      this.toast.success('Preferences saved');
    } catch {
      this.toast.error("Couldn't save preferences — try again");
    }
  }
}
