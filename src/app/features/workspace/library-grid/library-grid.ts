import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCheck,
  lucideDownload,
  lucidePencil,
  lucideSparkles,
  lucideTrash2,
  lucideVideo,
  lucideWandSparkles,
  lucideX,
} from '@ng-icons/lucide';
import { GenerationItem } from '../../../core/generations/generation-store';
import { CachedSrc } from '../../../core/media/cached-src';

export type LibraryFilter = 'all' | 'image' | 'video' | 'edit' | 'upscale';

@Component({
  selector: 'app-library-grid',
  templateUrl: './library-grid.html',
  styleUrl: './library-grid.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgIcon, CachedSrc],
  providers: [
    provideIcons({
      lucideCheck,
      lucideDownload,
      lucidePencil,
      lucideSparkles,
      lucideTrash2,
      lucideVideo,
      lucideWandSparkles,
      lucideX,
    }),
  ],
})
export class LibraryGrid {
  readonly items = input.required<GenerationItem[]>();
  readonly pickMode = input(false);
  readonly samplePrompts = input<string[]>([]);
  readonly search = input('');

  readonly opened = output<string>();
  readonly picked = output<string>();
  readonly download = output<string>();
  readonly upscale = output<string>();
  readonly variation = output<string>();
  readonly edit = output<string>();
  readonly retry = output<string>();
  readonly promptPicked = output<string>();
  /** Ids to delete — one card, or a whole multi-select batch. */
  readonly deleted = output<string[]>();

  /** Multi-select mode: cards toggle a checkbox instead of opening. */
  readonly selectMode = signal(false);
  readonly selectedIds = signal<Set<string>>(new Set());
  readonly selectedCount = computed(() => this.selectedIds().size);

  readonly filter = signal<LibraryFilter>('all');
  readonly filters: { id: LibraryFilter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'image', label: 'Images' },
    { id: 'video', label: 'Videos' },
    { id: 'edit', label: 'Edited' },
    { id: 'upscale', label: 'Upscaled' },
  ];

  readonly visible = computed(() => {
    const f = this.filter();
    const q = this.search().trim().toLowerCase();
    return this.items().filter((i) => {
      if (q && !i.prompt.toLowerCase().includes(q) && !i.familyName.toLowerCase().includes(q)) {
        return false;
      }
      if (f === 'all') return true;
      if (f === 'image') return i.kind === 'image' && (i.op === 'generate' || i.op === 'variation');
      if (f === 'video') return i.kind === 'video';
      if (f === 'edit') return i.op === 'edit';
      return i.op === 'upscale';
    });
  });

  onCardClick(item: GenerationItem): void {
    if (this.pickMode()) this.picked.emit(item.id);
    else if (this.selectMode()) this.toggleSelected(item.id);
    else this.opened.emit(item.id);
  }

  toggleSelectMode(): void {
    this.selectMode.update((on) => !on);
    this.selectedIds.set(new Set());
  }

  isSelected(id: string): boolean {
    return this.selectedIds().has(id);
  }

  toggleSelected(id: string): void {
    this.selectedIds.update((set) => {
      const next = new Set(set);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** Delete one card straight from its hover overlay. */
  deleteOne(id: string): void {
    if (confirm('Delete this generation? This cannot be undone.')) {
      this.deleted.emit([id]);
    }
  }

  /** Delete every checked card, then leave select mode. */
  deleteSelected(): void {
    const ids = [...this.selectedIds()];
    if (ids.length === 0) return;
    const noun = ids.length === 1 ? 'this generation' : `these ${ids.length} generations`;
    if (!confirm(`Delete ${noun}? This cannot be undone.`)) return;
    this.deleted.emit(ids);
    this.selectMode.set(false);
    this.selectedIds.set(new Set());
  }
}
