import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideDownload,
  lucidePencil,
  lucideRefreshCw,
  lucideSparkles,
  lucideTrash2,
  lucideX,
} from '@ng-icons/lucide';
import { GenerationItem } from '../../../core/generations/generation-store';
import type { RetryableDto } from '../../../core/api/dtos';
import {
  familyById,
  upscaleCreditCost,
  videoFamilySupports,
} from '../../../core/catalog/model-families';
import { CachedSrc } from '../../../core/media/cached-src';
import { DialogDirective } from '../../../shared/a11y/dialog.directive';

/**
 * Lightweight hand-rolled modal (fixed overlay + Esc/backdrop close) — spartan's
 * dialog service is built around templated triggers; this stays a dumb component.
 */
@Component({
  selector: 'app-detail-overlay',
  templateUrl: './detail-overlay.html',
  styleUrl: './detail-overlay.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, NgIcon, CachedSrc, DialogDirective],
  providers: [
    provideIcons({
      lucideDownload,
      lucideSparkles,
      lucidePencil,
      lucideRefreshCw,
      lucideTrash2,
      lucideX,
    }),
  ],
})
export class DetailOverlay {
  readonly item = input.required<GenerationItem>();
  readonly parent = input<GenerationItem | null>(null);
  /** True while an action on this item is in flight — buttons disable and spin. */
  readonly busy = input(false);
  /**
   * What the server says this item can do. Defaults to nothing: the probe is
   * in flight when the overlay first paints, and offering a control that
   * turns out to be dead is worse than showing it a moment late.
   */
  readonly retryable = input<RetryableDto>({ retry: false, variation: false });

  readonly closed = output<void>();
  readonly download = output<string>();
  readonly upscale = output<string>();
  readonly variation = output<string>();
  readonly retry = output<string>();
  readonly edit = output<string>();
  readonly deleted = output<string>();
  readonly openParent = output<string>();
  readonly extend = output<GenerationItem>();
  readonly editVideo = output<GenerationItem>();

  readonly upscaleCredits = upscaleCreditCost();

  /**
   * A disabled button with a reason is honest; one that always fails is not.
   * The label carries the reason so a screen reader hears it too.
   */
  readonly retryLabel = computed(() =>
    this.retryable().retry ? 'Retry this generation' : (this.retryable().reason ?? 'Retry'),
  );

  readonly variationLabel = computed(() =>
    this.retryable().variation
      ? 'Make a variation of this image'
      : 'Variations only apply to generated images.',
  );

  /** Extend continues this clip, so only the clip's own family counts. */
  readonly canExtend = computed(() => {
    const family = familyById(this.item().familyId);
    if (!family) return false;
    return videoFamilySupports(family, 'extend');
  });
  readonly canEditVideo = computed(() => this.item().familyId === 'omni');

  settingsChips(item: GenerationItem): string[] {
    const s = item.settings;
    return [
      s.version ? `v${s.version}` : null,
      s.aspectRatio,
      s.resolution ?? null,
      s.quality ?? null,
      s.durationS ? `${s.durationS}s` : null,
    ].filter((c): c is string => !!c);
  }

  confirmDelete(): void {
    if (confirm('Delete this generation? This cannot be undone.')) {
      this.deleted.emit(this.item().id);
    }
  }
}
