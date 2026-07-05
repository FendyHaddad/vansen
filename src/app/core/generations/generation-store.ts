import { Injectable, signal } from '@angular/core';
import { GenerationSettings, ModelKind } from '../catalog/model-families';

export type GenerationOp = 'generate' | 'edit' | 'upscale' | 'variation';

export interface GenerationItem {
  id: string;
  at: string; // ISO timestamp
  kind: ModelKind;
  familyId: string;
  familyName: string;
  op: GenerationOp;
  prompt: string;
  settings: GenerationSettings;
  priceUsd: number;
  status: 'pending' | 'done';
  mediaUrl: string;
  parentId?: string;
}

const STORAGE_KEY = 'vansen.generations';

/** Placeholder outputs until real generation wires in (all verified loadable). */
const PLACEHOLDER_MEDIA = [
  'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=640&q=80',
  'https://images.unsplash.com/photo-1541701494587-cb58502866ab?w=640&q=80',
  'https://images.unsplash.com/photo-1462331940025-496dfbfc7564?w=640&q=80',
  'https://images.unsplash.com/photo-1550745165-9bc0b252726f?w=640&q=80',
  'https://images.unsplash.com/photo-1526374965328-7f61d4dc18c5?w=640&q=80',
  'https://images.unsplash.com/photo-1483347756197-71ef80e95f73?w=640&q=80',
];

@Injectable({ providedIn: 'root' })
export class GenerationStore {
  private readonly state = signal<GenerationItem[]>(restore());
  private seedCounter = this.state().length;

  /** Newest first. */
  readonly items = this.state.asReadonly();

  byId(id: string): GenerationItem | undefined {
    return this.state().find((item) => item.id === id);
  }

  /** Ancestors (via parentId) + self + descendants, oldest first. */
  chainFor(id: string): GenerationItem[] {
    const all = this.state();
    const chain: GenerationItem[] = [];
    // walk up
    let current = this.byId(id);
    while (current) {
      chain.unshift(current);
      current = current.parentId ? this.byId(current.parentId) : undefined;
    }
    // walk down from id
    let frontier = [id];
    while (frontier.length) {
      const children = all.filter((i) => i.parentId && frontier.includes(i.parentId));
      chain.push(...children.filter((c) => !chain.includes(c)));
      frontier = children.map((c) => c.id);
    }
    return chain.sort((a, b) => a.at.localeCompare(b.at));
  }

  add(item: Omit<GenerationItem, 'id' | 'at' | 'status'>): string {
    const id = crypto.randomUUID();
    const entry: GenerationItem = {
      ...item,
      id,
      at: new Date().toISOString(),
      status: 'pending',
    };
    this.state.update((list) => [entry, ...list]);
    persist(this.state());
    // Stub latency: real dispatch is an Edge Function + provider webhook/poll
    setTimeout(() => {
      this.state.update((list) =>
        list.map((i) => (i.id === id ? { ...i, status: 'done' as const } : i)),
      );
      persist(this.state());
    }, 1400);
    return id;
  }

  remove(id: string): void {
    this.state.update((list) => list.filter((i) => i.id !== id));
    persist(this.state());
  }

  clear(): void {
    this.state.set([]);
    persist([]);
  }

  placeholderFor(seed?: number): string {
    const n = seed ?? this.seedCounter++;
    return PLACEHOLDER_MEDIA[Math.abs(n) % PLACEHOLDER_MEDIA.length];
  }
}

function restore(): GenerationItem[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? (parsed as GenerationItem[]).map((i) => ({ ...i, status: 'done' as const }))
      : [];
  } catch {
    return [];
  }
}

function persist(items: GenerationItem[]): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
}
