import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  output,
  signal,
} from '@angular/core';
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
import { prepPhoto } from '../../../core/personas/photo-prep';
import { ApiService } from '../../../core/api/api-service';
import { UploadResponse } from '../../../core/api/dtos';
import { LedgerService } from '../../../core/ledger/ledger-service';
import { ProfileStore } from '../../../core/profile/profile-store';
import { PERSONA_TRAINING } from '../../../core/catalog/model-families';
import { PersonaStatus } from '../../../core/enums';

interface WizardPhoto {
  uploadId: string;
  url: string;
}

/** "My personas" dialog: list with status/delete, and the create wizard
 * (name → consent attestation → photo grid → train for 350 credits). */
@Component({
  selector: 'app-persona-manager',
  templateUrl: './persona-manager.html',
  styleUrl: './persona-manager.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgIcon, HlmButton],
  providers: [
    provideIcons({ lucideLoaderCircle, lucidePlus, lucideTrash2, lucideUserRound, lucideX }),
  ],
})
export class PersonaManager {
  private readonly store = inject(PersonaStore);
  private readonly api = inject(ApiService);
  private readonly ledger = inject(LedgerService);
  private readonly profile = inject(ProfileStore);

  readonly dismissed = output<void>();

  readonly personas = this.store.items;
  readonly slots = this.store.slots;
  readonly statuses = PersonaStatus;
  readonly training = PERSONA_TRAINING;

  readonly creating = signal(false);
  readonly name = signal('');
  readonly attested = signal(false);
  readonly photos = signal<WizardPhoto[]>([]);
  readonly uploading = signal(false);
  readonly busy = signal(false);
  /** Persona id with a retry/delete in flight — its row buttons spin. */
  readonly itemBusy = signal<string | null>(null);
  readonly error = signal('');

  readonly slotsFull = computed(() => this.slots().used >= this.slots().max);
  readonly canAfford = computed(
    () => this.profile.isOwner() || this.ledger.totalCredits() >= PERSONA_TRAINING.creditCost,
  );
  readonly canTrain = computed(
    () =>
      this.name().trim().length > 0 &&
      this.attested() &&
      this.photos().length >= PERSONA_TRAINING.minPhotos &&
      this.photos().length <= PERSONA_TRAINING.maxPhotos &&
      this.canAfford() &&
      !this.uploading() &&
      !this.busy(),
  );

  startCreate(): void {
    this.creating.set(true);
    this.error.set('');
  }

  cancelCreate(): void {
    this.creating.set(false);
    this.name.set('');
    this.attested.set(false);
    this.photos.set([]);
    this.error.set('');
  }

  async onPhotosPicked(event: Event): Promise<void> {
    const inputEl = event.target as HTMLInputElement;
    const files = Array.from(inputEl.files ?? []);
    inputEl.value = '';
    if (files.length === 0) return;
    this.error.set('');
    this.uploading.set(true);
    try {
      const room = PERSONA_TRAINING.maxPhotos - this.photos().length;
      for (const file of files.slice(0, room)) {
        const prepped = await prepPhoto(file);
        const form = new FormData();
        form.append('file', prepped, 'photo.jpg');
        const res = await this.api.postForm<UploadResponse>('/uploads', form);
        this.photos.update((list) => [...list, { uploadId: res.uploadId, url: res.url }]);
      }
    } catch (e) {
      this.error.set(
        (e as { code?: string })?.code === 'content_policy'
          ? 'A photo violates our content policy and was rejected.'
          : 'A photo failed to upload — try again.',
      );
    } finally {
      this.uploading.set(false);
    }
  }

  removePhoto(uploadId: string): void {
    this.photos.update((list) => list.filter((p) => p.uploadId !== uploadId));
  }

  async trainNow(): Promise<void> {
    if (!this.canTrain()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      const persona = await this.store.create({ name: this.name().trim(), attested: true });
      await this.store.train(
        persona.id,
        this.photos().map((p) => p.uploadId),
      );
      this.cancelCreate();
    } catch (e) {
      const code = (e as { code?: string })?.code;
      this.error.set(
        code === 'insufficient_credits'
          ? 'Not enough credits for training.'
          : code === 'slot_limit'
            ? 'All persona slots are in use.'
            : 'Training could not be started — you were not charged.',
      );
    } finally {
      this.busy.set(false);
    }
  }

  /** Failed personas hold their charge refund already; a retry is a fresh run.
   * Simplest safe path: free the slot and restart the wizard. */
  async retry(id: string): Promise<void> {
    if (this.itemBusy()) return;
    this.itemBusy.set(id);
    try {
      await this.store.remove(id);
      this.startCreate();
    } catch {
      this.error.set('Could not clear the failed persona — try again.');
    } finally {
      this.itemBusy.set(null);
    }
  }

  async remove(id: string): Promise<void> {
    if (this.itemBusy()) return;
    if (!confirm('Delete this persona? Its trained likeness is removed and the slot freed.')) {
      return;
    }
    this.itemBusy.set(id);
    try {
      await this.store.remove(id);
    } catch {
      this.error.set('Delete failed — try again.');
    } finally {
      this.itemBusy.set(null);
    }
  }

  close(): void {
    if (this.busy() || this.uploading() || this.itemBusy()) return;
    this.dismissed.emit();
  }
}
