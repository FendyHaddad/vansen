import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiService } from '../api/api-service';
import { PersonaDto, PersonasResponse } from '../api/dtos';
import { PERSONA_SLOT_ORDER } from '../catalog/model-families';
import { PersonaStore } from './persona-store';

const draft: PersonaDto = {
  id: 'p1',
  name: 'Me',
  status: 'draft',
  photos: PERSONA_SLOT_ORDER.map((slot) => ({ slot, url: null })),
  thumbUrl: '',
  createdAt: '2026-07-24T00:00:00Z',
};

describe('PersonaStore', () => {
  const api = { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() };
  let store: PersonaStore;

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: ApiService, useValue: api }],
    });
    store = TestBed.inject(PersonaStore);
  });

  it('loads items and slots', async () => {
    api.get.mockResolvedValue({
      items: [{ ...draft, status: 'ready' }],
      slots: { used: 1, max: 2 },
    } satisfies PersonasResponse);
    await store.load();
    expect(store.items().length).toBe(1);
    expect(store.slots().max).toBe(2);
  });

  it('readyById returns only ready personas', async () => {
    api.get.mockResolvedValue({
      items: [{ ...draft, status: 'ready' }, { ...draft, id: 'p2', status: 'draft' }],
      slots: { used: 2, max: 2 },
    } satisfies PersonasResponse);
    await store.load();
    expect(store.readyById('p1')?.id).toBe('p1');
    expect(store.readyById('p2')).toBeUndefined();
  });

  it('remove drops the item locally and frees a slot', async () => {
    api.get.mockResolvedValue({ items: [draft], slots: { used: 1, max: 2 } } satisfies PersonasResponse);
    api.delete.mockResolvedValue({ ok: true });
    await store.load();
    await store.remove('p1');
    expect(store.items().length).toBe(0);
    expect(store.slots().used).toBe(0);
  });

  it('setPhoto PUTs the slot and replaces the persona in the list', async () => {
    api.get.mockResolvedValue({ items: [draft], slots: { used: 1, max: 2 } });
    await store.load();
    api.put.mockResolvedValue({ item: { ...draft, status: 'ready' } });
    await store.setPhoto(draft.id, 'front', 'u/1.jpg');
    expect(api.put).toHaveBeenCalledWith(`/personas/${draft.id}/photos/front`, { uploadId: 'u/1.jpg' });
    expect(store.items()[0].status).toBe('ready');
  });
});
