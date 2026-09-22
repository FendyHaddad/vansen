import { Injectable, inject, signal } from '@angular/core';
import { SessionLifecycle } from '../auth/session-lifecycle';
import { ApiService } from '../api/api-service';
import { CreatePersonaRequest, PersonaDto, PersonasResponse } from '../api/dtos';
import { PersonaStatus } from '../enums';
import { PersonaSlot } from '../catalog/model-families';

/** API-backed persona list. A persona is ready as soon as its five slots are
 * filled; nothing trains, so nothing polls. */
@Injectable({ providedIn: 'root' })
export class PersonaStore {
  private readonly api = inject(ApiService);

  private readonly itemsSig = signal<PersonaDto[]>([]);
  private readonly slotsSig = signal<{ used: number; max: number }>({ used: 0, max: 0 });
  private readonly loadedSig = signal(false);

  readonly items = this.itemsSig.asReadonly();
  readonly slots = this.slotsSig.asReadonly();
  readonly loaded = this.loadedSig.asReadonly();

  constructor() {
    inject(SessionLifecycle).register('personas', this);
  }

  readyById(id: string): PersonaDto | undefined {
    return this.itemsSig().find((p) => p.id === id && p.status === PersonaStatus.Ready);
  }

  async load(): Promise<void> {
    const res = await this.api.get<PersonasResponse>('/personas');
    this.itemsSig.set(res.items);
    this.slotsSig.set(res.slots);
    this.loadedSig.set(true);
  }

  async create(request: CreatePersonaRequest): Promise<PersonaDto> {
    const res = await this.api.post<{ item: PersonaDto }>('/personas', request);
    this.itemsSig.update((list) => [res.item, ...list]);
    this.slotsSig.update((s) => ({ ...s, used: s.used + 1 }));
    return res.item;
  }

  async setPhoto(id: string, slot: PersonaSlot, uploadId: string): Promise<PersonaDto> {
    const res = await this.api.put<{ item: PersonaDto }>(`/personas/${id}/photos/${slot}`, {
      uploadId,
    });
    this.itemsSig.update((list) => list.map((p) => (p.id === id ? res.item : p)));
    return res.item;
  }

  async remove(id: string): Promise<void> {
    await this.api.delete(`/personas/${id}`);
    this.itemsSig.update((list) => list.filter((p) => p.id !== id));
    this.slotsSig.update((s) => ({ ...s, used: Math.max(0, s.used - 1) }));
  }

  reset(): void {
    this.itemsSig.set([]);
    this.slotsSig.set({ used: 0, max: 0 });
    this.loadedSig.set(false);
  }
}
