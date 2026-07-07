import { Injectable, inject, signal } from '@angular/core';
import { ApiService } from '../api/api-service';
import {
  CreateGenerationRequest,
  CreateGenerationResponse,
  GenerationDto,
  GenerationsResponse,
} from '../api/dtos';
import { GenerationOp } from '../enums';
import { LedgerService } from '../ledger/ledger-service';

export type { GenerationOp };
export type GenerationItem = GenerationDto;

/** API-backed library. Server assigns prices, media, and ids. */
@Injectable({ providedIn: 'root' })
export class GenerationStore {
  private readonly api = inject(ApiService);
  private readonly ledger = inject(LedgerService);

  private readonly itemsSig = signal<GenerationDto[]>([]);
  private readonly loadedSig = signal(false);

  /** Newest first. */
  readonly items = this.itemsSig.asReadonly();
  readonly loaded = this.loadedSig.asReadonly();

  byId(id: string): GenerationDto | undefined {
    return this.itemsSig().find((item) => item.id === id);
  }

  /** Ancestors (via parentId) + self + descendants, oldest first. */
  chainFor(id: string): GenerationDto[] {
    const all = this.itemsSig();
    const chain: GenerationDto[] = [];
    let current = this.byId(id);
    while (current) {
      chain.unshift(current);
      current = current.parentId ? this.byId(current.parentId) : undefined;
    }
    let frontier = [id];
    while (frontier.length) {
      const children = all.filter((i) => i.parentId && frontier.includes(i.parentId));
      chain.push(...children.filter((c) => !chain.includes(c)));
      frontier = children.map((c) => c.id);
    }
    return chain.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async load(): Promise<void> {
    const response = await this.api.get<GenerationsResponse>('/generations');
    this.itemsSig.set(response.items);
    this.loadedSig.set(true);
  }

  /** Charges on the server, prepends the created items, updates the balance. */
  async create(request: CreateGenerationRequest): Promise<GenerationDto[]> {
    const response = await this.api.post<CreateGenerationResponse>('/generations', request);
    this.itemsSig.update((list) => [...response.items, ...list]);
    this.ledger.setBalance(response.balanceUsd);
    return response.items;
  }

  async remove(id: string): Promise<void> {
    await this.api.delete(`/generations/${id}`);
    this.itemsSig.update((list) => list.filter((i) => i.id !== id));
  }

  reset(): void {
    this.itemsSig.set([]);
    this.loadedSig.set(false);
  }
}
