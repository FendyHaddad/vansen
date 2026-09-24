import { ChangeDetectionStrategy, Component, computed, inject, output, signal } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideLoaderCircle,
  lucidePlus,
  lucideTrash2,
  lucideUserRound,
  lucideX,
} from '@ng-icons/lucide';
import { HlmButton } from '@spartan-ng/helm/button';
import { PersonaStore } from '../../../core/personas/persona-store';
import { ToastService } from '../../../core/feedback/toast-service';
import { prepPhoto, PhotoTooSmallError } from '../../../core/personas/photo-prep';
import { ApiService } from '../../../core/api/api-service';
import { PersonaDto, UploadResponse } from '../../../core/api/dtos';
import {
  PERSONA_MAX_BYTES,
  PERSONA_MIN_EDGE,
  PERSONA_NAME_MAX,
  PERSONA_SLOT_LABELS,
  PERSONA_SLOT_ORDER,
  PersonaSlot,
} from '../../../core/catalog/model-families';
import { PersonaStatus } from '../../../core/enums';
import { DialogDirective } from '../../../shared/a11y/dialog.directive';

/** Messages for `POST /personas` failures. Anything not listed here (an
 * idempotency replay conflict, a create that failed server-side, account
 * suspension, ...) gets the generic fallback below — the customer cannot act
 * differently on those, so a specific message would not help them. */
const CREATE_ERROR_MESSAGES: Record<string, string> = {
  slot_limit: 'All persona slots are in use.',
  studio_required: 'Personas need a Studio or Pro plan.',
};

/** Messages for a slot upload/PUT failure, by the server's error code.
 * `invalid_reference` carries its own server message (which photo problem it
 * was), so it is read off the error rather than looked up here. */
const SLOT_UPLOAD_MESSAGES: Record<string, string> = {
  photo_too_small: `Use a sharper, higher-resolution photo (at least ${PERSONA_MIN_EDGE}px).`,
  photo_too_large: `Use a smaller photo — at most ${PERSONA_MAX_BYTES / (1024 * 1024)} MB.`,
  account_suspended: 'Your account is suspended — contact support.',
  photo_unavailable:
    'That photo is in use by another persona or being removed — upload a new one.',
  content_policy: 'That photo violates our content policy and was rejected.',
  moderation_unavailable: 'Safety check is unavailable right now — try again shortly.',
};

/** "My personas" dialog: list with edit/delete, and a five-slot photo editor
 * per persona (no wizard, no training — a persona is ready once every slot
 * has a photo). */
@Component({
  selector: 'app-persona-manager',
  templateUrl: './persona-manager.html',
  styleUrl: './persona-manager.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgIcon, HlmButton, DialogDirective],
  providers: [
    provideIcons({ lucideLoaderCircle, lucidePlus, lucideTrash2, lucideUserRound, lucideX }),
  ],
})
export class PersonaManager {
  private readonly store = inject(PersonaStore);
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);

  readonly dismissed = output<void>();

  readonly personas = this.store.items;
  readonly slots = this.store.slots;
  readonly statuses = PersonaStatus;

  readonly slotOrder = PERSONA_SLOT_ORDER;
  readonly slotLabels: Record<PersonaSlot, string> = PERSONA_SLOT_LABELS;
  readonly nameMax = PERSONA_NAME_MAX;

  readonly creating = signal(false);
  readonly name = signal('');
  readonly attested = signal(false);
  readonly busy = signal(false);
  /** Persona id with a delete in flight — its row buttons spin. */
  readonly itemBusy = signal<string | null>(null);
  readonly error = signal('');

  /** The persona being built or edited, or null on the list view. */
  readonly editingId = signal<string | null>(null);
  readonly editing = computed(() => this.personas().find((p) => p.id === this.editingId()) ?? null);
  /** Slot with an upload in flight. */
  readonly uploadingSlot = signal<PersonaSlot | null>(null);

  readonly slotsFull = computed(() => this.slots().used >= this.slots().max);
  readonly canCreate = computed(
    () => this.name().trim().length > 0 && this.attested() && !this.busy(),
  );

  filledCount(p: PersonaDto): number {
    return p.photos.filter((x) => !!x.url).length;
  }

  guideUrl(slot: PersonaSlot): string {
    return `/personas/guides/${slot}.jpg`;
  }

  onGuideMissing(event: Event): void {
    (event.target as HTMLImageElement).src = '/personas/guides/silhouette.svg';
  }

  startCreate(): void {
    this.creating.set(true);
    this.error.set('');
  }

  cancelCreate(): void {
    this.creating.set(false);
    this.name.set('');
    this.attested.set(false);
    this.error.set('');
  }

  async createPersona(): Promise<void> {
    if (!this.canCreate()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      const persona = await this.store.create({ name: this.name().trim(), attested: true });
      this.creating.set(false);
      this.name.set('');
      this.attested.set(false);
      this.editingId.set(persona.id);
      this.toast.success('Persona created');
    } catch (e) {
      const code = (e as { code?: string })?.code ?? '';
      this.error.set(CREATE_ERROR_MESSAGES[code] ?? 'Could not create the persona.');
      this.toast.error("Couldn't create the persona");
    } finally {
      this.busy.set(false);
    }
  }

  edit(id: string): void {
    this.editingId.set(id);
    this.error.set('');
  }

  backToList(): void {
    this.editingId.set(null);
    this.error.set('');
  }

  async onSlotPicked(slot: PersonaSlot, event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    const persona = this.editing();
    if (!file || !persona) return;
    this.error.set('');
    this.uploadingSlot.set(slot);
    try {
      const prepped = await prepPhoto(file);
      const form = new FormData();
      form.append('file', prepped, 'photo.jpg');
      form.append('purpose', 'persona-photo');
      const res = await this.api.postForm<UploadResponse>('/uploads', form);
      await this.store.setPhoto(persona.id, slot, res.uploadId);
      this.toast.success('Photo uploaded');
    } catch (e) {
      this.toast.error('Photo upload failed');
      await this.handleSlotError(e);
    } finally {
      this.uploadingSlot.set(null);
    }
  }

  /** `not_found` means the persona was deleted from under us (another tab, an
   * expired session elsewhere) — the slot editor has nothing left to edit, so
   * this returns to the list and reloads it rather than showing a dead form. */
  private async handleSlotError(e: unknown): Promise<void> {
    const code = (e as { code?: string })?.code ?? '';
    if (code === 'not_found') {
      this.backToList();
      await this.store.load();
      this.error.set('That persona was deleted.');
      return;
    }
    this.error.set(this.uploadMessage(e));
  }

  private uploadMessage(e: unknown): string {
    if (e instanceof PhotoTooSmallError) return SLOT_UPLOAD_MESSAGES['photo_too_small'];
    const err = e as { code?: string; message?: string };
    const code = err.code ?? '';
    if (code === 'invalid_reference') {
      return err.message || "That photo can't be used — upload it again from this screen.";
    }
    return SLOT_UPLOAD_MESSAGES[code] ?? 'The photo failed to upload — try again.';
  }

  async remove(id: string): Promise<void> {
    if (this.itemBusy()) return;
    if (!confirm('Delete this persona? Its photos are removed and the slot freed.')) {
      return;
    }
    this.itemBusy.set(id);
    try {
      await this.store.remove(id);
      if (this.editingId() === id) this.editingId.set(null);
      this.toast.success('Persona deleted');
    } catch {
      this.error.set('Delete failed — try again.');
      this.toast.error("Couldn't delete the persona");
    } finally {
      this.itemBusy.set(null);
    }
  }

  close(): void {
    if (this.busy() || this.uploadingSlot() !== null || this.itemBusy()) return;
    this.dismissed.emit();
  }
}
