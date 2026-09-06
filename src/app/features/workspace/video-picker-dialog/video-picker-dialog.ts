import { ChangeDetectionStrategy, Component, computed, HostListener, input, output } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucidePlay, lucideX } from '@ng-icons/lucide';
import type { GenerationItem } from '../../../core/generations/generation-store';

@Component({
  selector: 'app-video-picker-dialog',
  imports: [NgIcon],
  providers: [provideIcons({ lucidePlay, lucideX })],
  templateUrl: './video-picker-dialog.html',
  styleUrl: './video-picker-dialog.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VideoPickerDialog {
  readonly items = input.required<GenerationItem[]>();
  readonly familyId = input.required<string>();
  readonly picked = output<GenerationItem>();
  readonly closed = output<void>();

  readonly candidates = computed(() => {
    const omniOnly = this.familyId() === 'omni';
    return this.items().filter((i) => {
      if (i.kind !== 'video' || i.status !== 'done') return false;
      if (omniOnly && i.familyId !== 'omni') return false;
      return true;
    });
  });

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.closed.emit();
  }

  onBackdrop(event: MouseEvent): void {
    if (event.target !== event.currentTarget) return;
    this.closed.emit();
  }
}
