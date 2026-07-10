import { Injectable, computed, inject, signal } from '@angular/core';
import { ApiService } from '../api/api-service';
import { ModelsResponse } from '../api/dtos';
import { readCache, writeCache } from '../api/local-cache';

/** Kill-switch flips are rare and the server enforces them anyway — the UI
 * grey-out may lag up to this long to skip a request on most boots. */
const MODELS_TTL_MS = 3_600_000;

/** Reads the kill-switch table so disabled families grey out in the UI. */
@Injectable({ providedIn: 'root' })
export class ModelAvailability {
  private readonly api = inject(ApiService);
  private readonly disabledSet = signal<Set<string>>(new Set());
  private readonly loadedSig = signal(false);

  readonly loaded = this.loadedSig.asReadonly();
  readonly disabledIds = computed(() => this.disabledSet());

  async load(): Promise<void> {
    const cached = readCache<ModelsResponse>('models', MODELS_TTL_MS);
    if (cached) {
      this.apply(cached);
      return;
    }
    const response = await this.api.get<ModelsResponse>('/models');
    this.apply(response);
    writeCache('models', response);
  }

  private apply(response: ModelsResponse): void {
    this.disabledSet.set(new Set(response.models.filter((m) => !m.enabled).map((m) => m.id)));
    this.loadedSig.set(true);
  }

  disabled(familyId: string): boolean {
    return this.disabledSet().has(familyId);
  }
}
