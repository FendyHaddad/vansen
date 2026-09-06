import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideImagePlus, lucideX } from '@ng-icons/lucide';
import { ApiService } from '../../../../core/api/api-service';
import type { UploadResponse } from '../../../../core/api/dtos';
import { referenceRule, type VideoMode } from '../../../../core/catalog/model-families';

export interface RefSlot {
  path: string;
  url: string;
}

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

function slotLabel(mode: VideoMode, index: number): string {
  if (mode === 'keyframes') return index === 0 ? 'First frame' : 'Last frame';
  if (mode === 'ref2v') return `Reference ${index + 1}`;
  return 'Image';
}

// Library pick for video references deliberately omitted — needs gateway referenceIds support (see punchlist).
@Component({
  selector: 'app-reference-drop',
  imports: [NgIcon],
  providers: [provideIcons({ lucideImagePlus, lucideX })],
  templateUrl: './reference-drop.html',
  styleUrl: './reference-drop.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReferenceDrop {
  private readonly api = inject(ApiService);

  readonly mode = input.required<VideoMode>();
  readonly slots = input.required<RefSlot[]>();
  readonly slotsChanged = output<RefSlot[]>();

  readonly error = signal('');
  readonly uploadingIndex = signal<number | null>(null);

  readonly max = computed(() => referenceRule(this.mode()).max);

  /** Filled slots + one empty (until max). Keyframes always show both. */
  readonly visible = computed(() => {
    const filled = this.slots();
    const shown = this.mode() === 'keyframes' ? this.max() : Math.min(filled.length + 1, this.max());
    return Array.from({ length: shown }, (_, i) => ({
      index: i,
      label: slotLabel(this.mode(), i),
      slot: filled[i] as RefSlot | undefined,
    }));
  });

  onFileInput(index: number, event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0];
    (event.target as HTMLInputElement).value = '';
    if (!file) return;
    void this.addFile(index, file);
  }

  onDrop(index: number, event: DragEvent): void {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    void this.addFile(index, file);
  }

  allowDrop(event: DragEvent): void {
    event.preventDefault();
  }

  async addFile(index: number, file: File): Promise<void> {
    this.error.set('');
    if (!file.type.startsWith('image/')) {
      this.error.set('Only images can be used as references.');
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      this.error.set('Image must be under 10 MB.');
      return;
    }
    const form = new FormData();
    form.append('file', file);
    this.uploadingIndex.set(index);
    try {
      const res = await this.api.postForm<UploadResponse>('/uploads', form);
      this.place(index, { path: res.uploadId, url: res.url });
    } catch (e) {
      this.error.set(messageOf(e));
    } finally {
      this.uploadingIndex.set(null);
    }
  }

  place(index: number, slot: RefSlot): void {
    const next = [...this.slots()];
    next[index] = slot;
    this.slotsChanged.emit(next.filter((s): s is RefSlot => !!s));
  }

  clear(index: number): void {
    const next = this.slots().filter((_, i) => i !== index);
    this.slotsChanged.emit(next);
  }
}

function messageOf(e: unknown): string {
  const err = e as { message?: string; error?: string } | null;
  if (err?.message) return err.message;
  return 'Upload failed. Try another image.';
}
