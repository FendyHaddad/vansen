import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideDownload,
  lucidePencil,
  lucideSparkles,
  lucideVideo,
  lucideWandSparkles,
} from '@ng-icons/lucide';
import { GenerationItem } from '../../../core/generations/generation-store';
import { upscaleUserPriceUsd } from '../../../core/catalog/model-families';

export type LibraryFilter = 'all' | 'image' | 'video' | 'edit' | 'upscale';

@Component({
  selector: 'app-library-grid',
  templateUrl: './library-grid.html',
  styleUrl: './library-grid.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe, NgIcon],
  providers: [
    provideIcons({ lucideDownload, lucidePencil, lucideSparkles, lucideVideo, lucideWandSparkles }),
  ],
})
export class LibraryGrid {
  readonly items = input.required<GenerationItem[]>();
  readonly pickMode = input(false);
  readonly samplePrompts = input<string[]>([]);

  readonly opened = output<string>();
  readonly picked = output<string>();
  readonly download = output<string>();
  readonly upscale = output<string>();
  readonly variation = output<string>();
  readonly edit = output<string>();
  readonly promptPicked = output<string>();

  readonly filter = signal<LibraryFilter>('all');
  readonly filters: { id: LibraryFilter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'image', label: 'Images' },
    { id: 'video', label: 'Videos' },
    { id: 'edit', label: 'Edited' },
    { id: 'upscale', label: 'Upscaled' },
  ];

  readonly upscalePrice = upscaleUserPriceUsd();

  readonly visible = computed(() => {
    const f = this.filter();
    return this.items().filter((i) => {
      if (f === 'all') return true;
      if (f === 'image') return i.kind === 'image' && (i.op === 'generate' || i.op === 'variation');
      if (f === 'video') return i.kind === 'video';
      if (f === 'edit') return i.op === 'edit';
      return i.op === 'upscale';
    });
  });

  onCardClick(item: GenerationItem): void {
    if (this.pickMode()) this.picked.emit(item.id);
    else this.opened.emit(item.id);
  }
}
