import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { ModelFamily, VideoMode } from '../../../../core/catalog/model-families';
import { Hint } from '../../../../shared/hint/hint';

export const MODE_LABELS: Record<VideoMode, string> = {
  t2v: 'Text → Video',
  i2v: 'Image → Video',
  ref2v: 'References → Video',
  keyframes: 'First + Last frame',
  extend: 'Extend',
  edit: 'Edit',
};

export const MODE_HINTS: Record<VideoMode, string> = {
  t2v: 'Describe the clip. No images needed.',
  i2v: 'One image becomes the opening frame.',
  ref2v: 'Up to 3 images guide characters, objects or style.',
  keyframes: 'Two images: where the clip starts and where it ends.',
  extend: 'Continue a finished video from your library.',
  edit: 'Change a finished video by describing the edit.',
};

const ORDER: VideoMode[] = ['t2v', 'i2v', 'ref2v', 'keyframes', 'extend', 'edit'];

@Component({
  selector: 'app-mode-picker',
  imports: [Hint],
  templateUrl: './mode-picker.html',
  styleUrl: './mode-picker.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ModePicker {
  readonly family = input.required<ModelFamily>();
  readonly selected = input.required<VideoMode>();
  readonly changed = output<VideoMode>();

  readonly labels = MODE_LABELS;
  readonly hints = MODE_HINTS;
  readonly modes = computed(() => {
    const supported = new Set(this.family().capabilities.modes ?? []);
    return ORDER.filter((m) => supported.has(m));
  });

  pick(mode: VideoMode): void {
    if (mode === this.selected()) return;
    this.changed.emit(mode);
  }
}
