import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  input,
  OnDestroy,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCheck,
  lucideDownload,
  lucidePencil,
  lucidePlay,
  lucideSparkles,
  lucideTrash2,
  lucideVideo,
  lucideWandSparkles,
  lucideX,
} from '@ng-icons/lucide';
import { GenerationItem } from '../../../core/generations/generation-store';
import { CachedSrc } from '../../../core/media/cached-src';
import { PosterService } from '../../../core/media/poster-service';
import { PendingVideoCard } from '../pending-video-card/pending-video-card';

export type LibraryFilter = 'all' | 'image' | 'video' | 'edit' | 'upscale';

@Component({
  selector: 'app-library-grid',
  templateUrl: './library-grid.html',
  styleUrl: './library-grid.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgIcon, CachedSrc, PendingVideoCard],
  providers: [
    provideIcons({
      lucideCheck,
      lucideDownload,
      lucidePencil,
      lucidePlay,
      lucideSparkles,
      lucideTrash2,
      lucideVideo,
      lucideWandSparkles,
      lucideX,
    }),
  ],
})
export class LibraryGrid implements OnDestroy {
  readonly poster = inject(PosterService);

  readonly items = input.required<GenerationItem[]>();
  /** True while there are older items the server has not sent yet. */
  readonly hasMore = input(false);
  readonly loadingMore = input(false);
  /** Item ids with an action in flight — their buttons show a spinner and stay disabled. */
  readonly busyIds = input<Set<string>>(new Set());
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
  readonly cancel = output<string>();
  /** The bottom of the list came into view; ask for the next page. */
  readonly moreWanted = output<void>();

  private readonly sentinel = viewChild<ElementRef<HTMLElement>>('sentinel');

  /**
   * Ask for the next page when the end of the list is actually reached.
   *
   * A scroll listener would run on every frame and still have to guess at the
   * distance; the observer fires once, when the marker below the last tile
   * enters the viewport.
   */
  private observer?: IntersectionObserver;
  private readonly sentinelEffect = effect(() => {
    const element = this.sentinel()?.nativeElement;
    this.observer?.disconnect();
    this.observer = undefined;
    if (!element || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      this.moreWanted.emit();
    }, { rootMargin: '400px' });
    observer.observe(element);
    this.observer = observer;
  });

  /**
   * What a tile shows: the server's thumbnail, falling back to the original
   * for anything made before thumbnails existed (0022 marks those `pending`
   * and the backfill works through them).
   */
  tileUrl(item: GenerationItem): string {
    return item.thumbUrl || item.mediaUrl;
  }

  /**
   * Tiles and the detail view cache under different keys. One key for both
   * would mean whichever loaded first decided what the other showed — a
   * 512 px tile in the detail overlay, or a 4 MP original in the grid.
   */
  tileKey(item: GenerationItem): string {
    return item.thumbUrl ? `${item.id}:thumb` : item.id;
  }

  /** Ticking clock the pending-video cards read for elapsed/eta — kept here
   * (not per-card) so every card re-renders off one shared interval. */
  readonly now = signal(Date.now());
  private readonly clock = setInterval(() => this.now.set(Date.now()), 1000);

  /** Kick off poster generation for every video item as it renders — the
   * service dedupes, so this is safe to run on every items() change. */
  private readonly posterEffect = effect(() => {
    for (const item of this.items()) this.poster.ensure(item);
  });

  ngOnDestroy(): void {
    clearInterval(this.clock);
    this.observer?.disconnect();
  }

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

  /**
   * What a screen reader reads instead of "image".
   *
   * The tiles are visually distinguished by their picture alone, so without
   * this every card in the grid announces identically and the list is
   * unusable by ear.
   */
  cardLabel(item: GenerationItem): string {
    const kind = item.kind === 'video' ? 'Video' : 'Image';
    const status = item.status === 'done' ? '' : `, ${item.status}`;
    return `${kind}: ${item.prompt.slice(0, 80)}${status}`;
  }

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

  /**
   * Cancelled, not failed.
   *
   * The server now persists this, so it survives a reload. `error` is the
   * older signal and is kept as a fallback for rows settled before the
   * failure columns were written.
   */
  isCancelled(item: GenerationItem): boolean {
    if (item.failure) return item.failure.cancelled;
    return item.error === 'cancelled';
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
