import { ChangeDetectionStrategy, Component, HostListener, input, output } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideDownload,
  lucidePencil,
  lucideSparkles,
  lucideTrash2,
  lucideX,
} from '@ng-icons/lucide';
import { GenerationItem } from '../../../core/generations/generation-store';
import { upscaleUserPriceUsd } from '../../../core/catalog/model-families';

/**
 * Lightweight hand-rolled modal (fixed overlay + Esc/backdrop close) — spartan's
 * dialog service is built around templated triggers; this stays a dumb component.
 */
@Component({
  selector: 'app-detail-overlay',
  templateUrl: './detail-overlay.html',
  styleUrl: './detail-overlay.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, DecimalPipe, NgIcon],
  providers: [
    provideIcons({ lucideDownload, lucideSparkles, lucidePencil, lucideTrash2, lucideX }),
  ],
})
export class DetailOverlay {
  readonly item = input.required<GenerationItem>();
  readonly parent = input<GenerationItem | null>(null);

  readonly closed = output<void>();
  readonly download = output<string>();
  readonly upscale = output<string>();
  readonly variation = output<string>();
  readonly edit = output<string>();
  readonly deleted = output<string>();
  readonly openParent = output<string>();

  readonly upscalePrice = upscaleUserPriceUsd();

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
    ].filter((c): c is string => !!c);
  }

  confirmDelete(): void {
    if (confirm('Delete this generation? This cannot be undone.')) {
      this.deleted.emit(this.item().id);
    }
  }
}
