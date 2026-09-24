import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideImagePlus, lucideX } from '@ng-icons/lucide';
import { ApiService } from '../../../../core/api/api-service';
import { ToastService } from '../../../../core/feedback/toast-service';
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
  private readonly toast = inject(ToastService);

  readonly mode = input.required<VideoMode>();
  /**
   * Positions, not a list. `keyframes` is [first, last] on every adapter, so
   * an empty first frame is a hole that stays a hole — never a shorter array.
   */
  readonly slots = input.required<(RefSlot | null)[]>();
  readonly slotsChanged = output<(RefSlot | null)[]>();

  readonly error = signal('');
  readonly uploadingIndex = signal<number | null>(null);

  readonly max = computed(() => referenceRule(this.mode()).max);

  /** Filled slots + one empty (until max). Keyframes always show both. */
  readonly visible = computed(() => {
    const filled = this.slots();
    // A trailing hole is still a slot the customer can fill, so count the
    // array's length rather than how many of them happen to be occupied.
    const shown = this.mode() === 'keyframes'
      ? this.max()
      : Math.min(filled.filter((s) => !!s).length + 1, this.max());
    return Array.from({ length: shown }, (_, i) => ({
      index: i,
      label: slotLabel(this.mode(), i),
      slot: filled[i] ?? undefined,
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
      this.toast.success('Reference added');
    } catch (e) {
      this.error.set(messageOf(e));
      this.toast.error('Upload failed');
    } finally {
      this.uploadingIndex.set(null);
    }
  }

  /**
   * Slots are positions, not a list. keyframes = [first, last] on every
   * adapter, so compacting the array silently promoted the end frame to the
   * start — the video then began where it was meant to end.
   */
  place(index: number, slot: RefSlot): void {
    const next = this.padded();
    next[index] = slot;
    this.slotsChanged.emit(next); // nulls preserved
  }

  clear(index: number): void {
    const next = this.padded();
    next[index] = null;
    this.slotsChanged.emit(next);
  }

  /** Every required position for this mode is filled. */
  complete(): boolean {
    const rule = referenceRule(this.mode());
    const filled = this.slots().filter((s) => !!s).length;
    if (filled < rule.min || filled > rule.max) return false;
    // No holes before the end: refs[1] with refs[0] empty is not one
    // reference, it is a missing first frame.
    return this.slots().slice(0, filled).every((s) => !!s);
  }

  /**
   * The provider array, in provider order. A sparse array is a bug, not a
   * shorter list.
   */
  serialize(): string[] {
    if (!this.complete()) throw new Error('reference slots incomplete');
    return this.slots().filter((s): s is RefSlot => !!s).map((s) => s.path);
  }

  /** The slot array grown to the mode's width, so an index always exists. */
  private padded(): (RefSlot | null)[] {
    const next = [...this.slots()];
    while (next.length < this.max()) next.push(null);
    return next;
  }
}

function messageOf(e: unknown): string {
  const err = e as { message?: string; error?: string } | null;
  if (err?.message) return err.message;
  return 'Upload failed. Try another image.';
}
