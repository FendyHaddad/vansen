import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  computed,
  input,
  output,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideDownload,
  lucidePencil,
  lucideSparkles,
  lucideTrash2,
  lucideX,
} from '@ng-icons/lucide';
import { GenerationItem } from '../../../core/generations/generation-store';
import {
  familyById,
  upscaleCreditCost,
  videoFamilySupports,
} from '../../../core/catalog/model-families';
import { styleById } from '../../../core/catalog/style-presets';
import { CachedSrc } from '../../../core/media/cached-src';

/**
 * Lightweight hand-rolled modal (fixed overlay + Esc/backdrop close) — spartan's
 * dialog service is built around templated triggers; this stays a dumb component.
 */
@Component({
  selector: 'app-detail-overlay',
  templateUrl: './detail-overlay.html',
  styleUrl: './detail-overlay.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, NgIcon, CachedSrc],
  providers: [
    provideIcons({ lucideDownload, lucideSparkles, lucidePencil, lucideTrash2, lucideX }),
  ],
})
export class DetailOverlay {
  readonly item = input.required<GenerationItem>();
  readonly parent = input<GenerationItem | null>(null);
  /** True while an action on this item is in flight — buttons disable and spin. */
  readonly busy = input(false);

  readonly closed = output<void>();
  readonly download = output<string>();
  readonly upscale = output<string>();
  readonly variation = output<string>();
  readonly edit = output<string>();
  readonly deleted = output<string>();
  readonly openParent = output<string>();
  readonly extend = output<GenerationItem>();
  readonly editVideo = output<GenerationItem>();

  readonly upscaleCredits = upscaleCreditCost();

  /** Extend continues this clip, so only the clip's own family counts. */
  readonly canExtend = computed(() => {
    const family = familyById(this.item().familyId);
    if (!family) return false;
    return videoFamilySupports(family, 'extend');
  });
  readonly canEditVideo = computed(() => this.item().familyId === 'omni');

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.closed.emit();
  }

  settingsChips(item: GenerationItem): string[] {
    const s = item.settings;
    return [
      s.version ? `v${s.version}` : null,
      s.aspectRatio,
      s.resolution ?? null,
      s.quality ?? null,
      s.durationS ? `${s.durationS}s` : null,
      s.style ? (styleById(s.style)?.name ?? null) : null,
    ].filter((c): c is string => !!c);
  }

  confirmDelete(): void {
    if (confirm('Delete this generation? This cannot be undone.')) {
      this.deleted.emit(this.item().id);
    }
  }
}
