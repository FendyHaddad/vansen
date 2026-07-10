import { Injectable, inject, signal } from '@angular/core';
import { ApiService } from '../api/api-service';
import {
  CreateGenerationRequest,
  CreateGenerationResponse,
  GenerationDto,
  GenerationsResponse,
  SaveEditResponse,
} from '../api/dtos';
import { GenerationOp } from '../enums';
import { LedgerService } from '../ledger/ledger-service';
import { currentUid, readCache, writeCache } from '../api/local-cache';
import { MediaCache } from '../media/media-cache';

export type { GenerationOp };
export type GenerationItem = GenerationDto;

/** API-backed library. Server assigns prices, media, and ids. */
@Injectable({ providedIn: 'root' })
export class GenerationStore {
  private readonly api = inject(ApiService);
  private readonly ledger = inject(LedgerService);
  private readonly media = inject(MediaCache);

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
    // Boot from the last snapshot instantly (thumbnails come from the media
    // cache by id, so expired signed URLs in it don't matter), then refresh.
    if (!this.loadedSig()) {
      const cached = readCache<GenerationDto[]>(`generations.${await currentUid()}`);
      if (cached) {
        this.itemsSig.set(cached);
        this.loadedSig.set(true);
      }
    }
    const response = await this.api.get<GenerationsResponse>('/generations');
    this.itemsSig.set(response.items);
    this.loadedSig.set(true);
    void this.persist();
  }

  /** Snapshot the list so the next app start paints without waiting. */
  private async persist(): Promise<void> {
    writeCache(`generations.${await currentUid()}`, this.itemsSig());
  }

  /** Charges on the server, prepends the created items, updates the balance. */
  async create(request: CreateGenerationRequest): Promise<GenerationDto[]> {
    const response = await this.api.post<CreateGenerationResponse>('/generations', request);
    this.itemsSig.update((list) => [...response.items, ...list]);
    this.ledger.setBalance(response.balanceUsd);
    void this.persist();
    return response.items;
  }

  /** Persist a locally-edited canvas as a $0 version row. */
  async saveEdit(blob: Blob, parentId: string): Promise<GenerationDto> {
    const form = new FormData();
    form.append('file', blob, 'edit.png');
    form.append('parentId', parentId);
    const res = await this.api.postForm<SaveEditResponse>('/edits/save', form);
    this.itemsSig.update((list) => [res.item, ...list]);
    void this.persist();
    return res.item;
  }

  /** Import the user's own image as a root $0 library item they can edit. */
  async importImage(file: File): Promise<GenerationDto> {
    const form = new FormData();
    form.append('file', file);
    const res = await this.api.postForm<SaveEditResponse>('/library/import', form);
    this.itemsSig.update((list) => [res.item, ...list]);
    void this.persist();
    return res.item;
  }

  async remove(id: string): Promise<void> {
    await this.api.delete(`/generations/${id}`);
    this.itemsSig.update((list) => list.filter((i) => i.id !== id));
    void this.media.evict(id);
    void this.persist();
  }

  /** Generation ids still awaiting their provider result. */
  pendingIds(): string[] {
    return this.itemsSig()
      .filter((i) => i.status === 'pending')
      .map((i) => i.id);
  }

  /** Merge poll results (status flips, media urls) into the store. */
  applyJobUpdates(updates: GenerationDto[]): void {
    if (updates.length === 0) return;
    const byId = new Map(updates.map((u) => [u.id, u]));
    this.itemsSig.update((list) => list.map((i) => byId.get(i.id) ?? i));
    void this.persist();
  }

  reset(): void {
    this.itemsSig.set([]);
    this.loadedSig.set(false);
  }
}
