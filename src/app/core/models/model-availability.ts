import { Injectable, computed, inject, signal } from '@angular/core';
import { ApiService } from '../api/api-service';
import { ModelsResponse } from '../api/dtos';

/** Reads the kill-switch table so disabled families grey out in the UI. */
@Injectable({ providedIn: 'root' })
export class ModelAvailability {
  private readonly api = inject(ApiService);
  private readonly disabledSet = signal<Set<string>>(new Set());
  private readonly loadedSig = signal(false);

  readonly loaded = this.loadedSig.asReadonly();
  readonly disabledIds = computed(() => this.disabledSet());

  async load(): Promise<void> {
    const response = await this.api.get<ModelsResponse>('/models');
    this.disabledSet.set(new Set(response.models.filter((m) => !m.enabled).map((m) => m.id)));
    this.loadedSig.set(true);
  }

  disabled(familyId: string): boolean {
    return this.disabledSet().has(familyId);
  }
}
