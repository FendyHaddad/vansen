import { Injectable, inject, signal } from '@angular/core';
import { ApiService } from '../api/api-service';
import {
  CreatePersonaRequest,
  PersonaDto,
  PersonasResponse,
  TrainPersonaResponse,
} from '../api/dtos';
import { PersonaStatus } from '../enums';
import { LedgerService } from '../ledger/ledger-service';

const POLL_MS = 10_000;

/** API-backed persona list. GET /personas settles in-flight trainings server-side,
 * so polling is just re-loading while anything is 'training'. */
@Injectable({ providedIn: 'root' })
export class PersonaStore {
  private readonly api = inject(ApiService);
  private readonly ledger = inject(LedgerService);

  private readonly itemsSig = signal<PersonaDto[]>([]);
  private readonly slotsSig = signal<{ used: number; max: number }>({ used: 0, max: 0 });
  private readonly loadedSig = signal(false);
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  readonly items = this.itemsSig.asReadonly();
  readonly slots = this.slotsSig.asReadonly();
  readonly loaded = this.loadedSig.asReadonly();

  readyById(id: string): PersonaDto | undefined {
    return this.itemsSig().find((p) => p.id === id && p.status === PersonaStatus.Ready);
  }

  async load(): Promise<void> {
    const res = await this.api.get<PersonasResponse>('/personas');
    this.itemsSig.set(res.items);
    this.slotsSig.set(res.slots);
    this.loadedSig.set(true);
    this.syncPolling();
  }

  async create(request: CreatePersonaRequest): Promise<PersonaDto> {
    const res = await this.api.post<{ item: PersonaDto }>('/personas', request);
    this.itemsSig.update((list) => [res.item, ...list]);
    this.slotsSig.update((s) => ({ ...s, used: s.used + 1 }));
    return res.item;
  }

  async train(id: string, photoUploadIds: string[]): Promise<PersonaDto> {
    const res = await this.api.post<TrainPersonaResponse>(`/personas/${id}/train`, {
      photoUploadIds,
    });
    this.itemsSig.update((list) => list.map((p) => (p.id === id ? res.item : p)));
    this.ledger.setCredits(res.credits);
    this.syncPolling();
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
    this.syncPolling();
  }

  /** Poll while any persona is training; stop when none are. */
  private syncPolling(): void {
    const training = this.itemsSig().some((p) => p.status === PersonaStatus.Training);
    if (training && !this.pollTimer) {
      this.pollTimer = setInterval(() => void this.load(), POLL_MS);
    } else if (!training && this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
