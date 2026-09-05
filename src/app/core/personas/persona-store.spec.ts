import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiService } from '../api/api-service';
import { LedgerService } from '../ledger/ledger-service';
import { PersonaDto, PersonasResponse } from '../api/dtos';
import { PersonaStore } from './persona-store';

const READY: PersonaDto = {
  id: 'p1',
  name: 'Me',
  status: 'ready',
  photoCount: 6,
  thumbUrl: '',
  error: null,
  createdAt: '2026-07-24T00:00:00Z',
  trainedAt: '2026-07-24T00:05:00Z',
};

describe('PersonaStore', () => {
  const apiMock = { get: vi.fn(), post: vi.fn(), delete: vi.fn() };
  const ledgerMock = { setCredits: vi.fn() };
  let store: PersonaStore;

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: ApiService, useValue: apiMock },
        { provide: LedgerService, useValue: ledgerMock },
      ],
    });
    store = TestBed.inject(PersonaStore);
  });

  it('loads items and slots', async () => {
    apiMock.get.mockResolvedValue({
      items: [READY],
      slots: { used: 1, max: 2 },
    } satisfies PersonasResponse);
    await store.load();
    expect(store.items().length).toBe(1);
    expect(store.slots().max).toBe(2);
  });

  it('readyById returns only ready personas', async () => {
    apiMock.get.mockResolvedValue({
      items: [READY, { ...READY, id: 'p2', status: 'training' }],
      slots: { used: 2, max: 2 },
    } satisfies PersonasResponse);
    await store.load();
    expect(store.readyById('p1')?.id).toBe('p1');
    expect(store.readyById('p2')).toBeUndefined();
  });

  it('remove drops the item locally and frees a slot', async () => {
    apiMock.get.mockResolvedValue({
      items: [READY],
      slots: { used: 1, max: 2 },
    } satisfies PersonasResponse);
    apiMock.delete.mockResolvedValue({ ok: true });
    await store.load();
    await store.remove('p1');
    expect(store.items().length).toBe(0);
    expect(store.slots().used).toBe(0);
  });

  it('train swaps the item and updates the balance', async () => {
    apiMock.get.mockResolvedValue({
      items: [{ ...READY, status: 'draft' }],
      slots: { used: 1, max: 2 },
    } satisfies PersonasResponse);
    apiMock.post.mockResolvedValue({
      item: { ...READY, status: 'training' },
      credits: { plan: 1150, pack: 0 },
    });
    await store.load();
    await store.train('p1', ['u/a.jpg', 'u/b.jpg', 'u/c.jpg', 'u/d.jpg', 'u/e.jpg']);
    expect(store.items()[0].status).toBe('training');
    expect(ledgerMock.setCredits).toHaveBeenCalledWith({ plan: 1150, pack: 0 });
  });
});
