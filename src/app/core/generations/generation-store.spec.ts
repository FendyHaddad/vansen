import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiService } from '../api/api-service';
import { LedgerService } from '../ledger/ledger-service';
import { MediaCache } from '../media/media-cache';
import { ProfileStore } from '../profile/profile-store';
import { NotificationStore } from '../notifications/notification-store';
import { GenerationDto } from '../api/dtos';
import { GenerationStore } from './generation-store';

function gen(id: string, status: GenerationDto['status'], priceCredits = 5): GenerationDto {
  return {
    id,
    kind: 'image',
    familyId: 'flux',
    familyName: 'FLUX',
    op: 'generate',
    prompt: 'p',
    settings: {},
    priceCredits,
    status,
    mediaUrl: '',
    parentId: null,
    createdAt: '2026-07-13T00:00:00Z',
  } as GenerationDto;
}

describe('GenerationStore.applyJobUpdates notifications', () => {
  const apiMock = { get: vi.fn(), post: vi.fn(), postForm: vi.fn(), delete: vi.fn() };
  const ledgerMock = { setCredits: vi.fn() };
  const mediaMock = { evict: vi.fn() };
  const profileMock = { load: vi.fn().mockResolvedValue(undefined) };
  const notifMock = { addMany: vi.fn() };

  async function makeWith(items: GenerationDto[]): Promise<GenerationStore> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: ApiService, useValue: apiMock },
        { provide: LedgerService, useValue: ledgerMock },
        { provide: MediaCache, useValue: mediaMock },
        { provide: ProfileStore, useValue: profileMock },
        { provide: NotificationStore, useValue: notifMock },
      ],
    });
    apiMock.get.mockResolvedValue({ items });
    const store = TestBed.inject(GenerationStore);
    await store.load();
    return store;
  }

  beforeEach(() => {
    localStorage.clear();
    apiMock.get.mockReset();
    profileMock.load.mockClear();
    notifMock.addMany.mockReset();
  });

  it('pending→done emits one ready notification', async () => {
    const store = await makeWith([gen('a', 'pending')]);
    store.applyJobUpdates([gen('a', 'done')]);
    expect(notifMock.addMany).toHaveBeenCalledTimes(1);
    const events = notifMock.addMany.mock.calls[0][0];
    expect(events).toEqual([
      expect.objectContaining({ kind: 'ready', genId: 'a', title: 'Image ready' }),
    ]);
    expect(profileMock.load).not.toHaveBeenCalled();
  });

  it('pending→failed emits a refund with credit amount and refreshes the balance', async () => {
    const store = await makeWith([gen('a', 'pending', 10)]);
    store.applyJobUpdates([gen('a', 'failed', 10)]);
    const events = notifMock.addMany.mock.calls[0][0];
    expect(events[0]).toEqual(
      expect.objectContaining({ kind: 'refund', genId: 'a', title: 'Refunded 10 credits' }),
    );
    expect(profileMock.load).toHaveBeenCalledTimes(1);
  });

  it('a repeat poll of an already-terminal item emits nothing', async () => {
    const store = await makeWith([gen('a', 'pending')]);
    store.applyJobUpdates([gen('a', 'done')]);
    notifMock.addMany.mockClear();
    store.applyJobUpdates([gen('a', 'done')]);
    expect(notifMock.addMany).not.toHaveBeenCalled();
  });

  it('unknown ids and still-pending updates emit nothing', async () => {
    const store = await makeWith([gen('a', 'pending')]);
    store.applyJobUpdates([gen('a', 'pending'), gen('zz', 'done')]);
    expect(notifMock.addMany).not.toHaveBeenCalled();
  });

  it('cancel requests a stop and leaves the item pending until the worker answers', async () => {
    const pending = {
      ...gen('g1', 'pending', 40),
      job: { cancellable: true, expectedS: 96, startedAt: '2026-07-13T00:00:00Z' },
    };
    const store = await makeWith([pending]);
    apiMock.post.mockResolvedValue({
      cancelling: true,
      refundedCredits: 0,
      credits: { plan: 100, pack: 0 },
    });

    const refunded = await store.cancel('g1');

    expect(apiMock.post).toHaveBeenCalledWith('/jobs/g1/cancel', {});
    // Nothing is refunded here: only a provider that confirms it stopped earns one.
    expect(refunded).toBe(0);
    expect(store.byId('g1')?.status).toBe('pending');
    // The button is gone, but the job is still watched.
    expect(store.byId('g1')?.job?.cancellable).toBe(false);
    expect(store.pendingIds()).toContain('g1');
    expect(ledgerMock.setCredits).toHaveBeenCalledWith({ plan: 100, pack: 0 });
  });

  it('pendingVideoCount counts only pending videos', async () => {
    const store = await makeWith([
      { ...gen('v1', 'pending'), kind: 'video' as const },
      { ...gen('v2', 'done'), kind: 'video' as const },
      gen('i1', 'pending'),
    ]);
    expect(store.pendingVideoCount()).toBe(1);
  });

  it('setThumb patches thumbUrl', async () => {
    const store = await makeWith([{ ...gen('v1', 'done'), kind: 'video' as const }]);
    store.setThumb('v1', 'https://t/v1.jpg');
    expect(store.byId('v1')?.thumbUrl).toBe('https://t/v1.jpg');
  });

  it('applyJobUpdates carries job progress on still-pending items', async () => {
    const store = await makeWith([{ ...gen('v1', 'pending'), kind: 'video' as const }]);
    store.applyJobUpdates([
      { ...gen('v1', 'pending'), kind: 'video', job: { progress: 0.4, phase: 'rendering', cancellable: true, expectedS: 96, startedAt: 'x' } },
    ]);
    expect(store.byId('v1')?.job?.progress).toBe(0.4);
    expect(notifMock.addMany).not.toHaveBeenCalled();
  });
});

describe('GenerationStore.create idempotency keys', () => {
  const apiMock = { get: vi.fn(), post: vi.fn(), postForm: vi.fn(), delete: vi.fn() };
  const ledgerMock = { setCredits: vi.fn() };
  const mediaMock = { evict: vi.fn() };
  const profileMock = { load: vi.fn().mockResolvedValue(undefined) };
  const notifMock = { addMany: vi.fn() };

  const request = {
    op: 'generate' as const,
    familyId: 'flux',
    prompt: 'a cat',
    batch: 1,
    settings: { aspectRatio: '1:1' },
  };

  function make(): GenerationStore {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: ApiService, useValue: apiMock },
        { provide: LedgerService, useValue: ledgerMock },
        { provide: MediaCache, useValue: mediaMock },
        { provide: ProfileStore, useValue: profileMock },
        { provide: NotificationStore, useValue: notifMock },
      ],
    });
    return TestBed.inject(GenerationStore);
  }

  function keysUsed(): string[] {
    return apiMock.post.mock.calls.map((call) => call[2]?.idempotencyKey);
  }

  beforeEach(() => {
    localStorage.clear();
    apiMock.post.mockReset();
    apiMock.post.mockResolvedValue({ items: [gen('a', 'pending')], credits: 100 });
  });

  it('a retry of the same submission reuses the key', async () => {
    const store = make();
    apiMock.post.mockRejectedValueOnce(new Error('network'));

    await expect(store.create({ ...request })).rejects.toThrow('network');
    await store.create({ ...request });

    const keys = keysUsed();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('an edited request gets a new key', async () => {
    const store = make();
    await store.create({ ...request });
    await store.create({ ...request, prompt: 'a dog' });

    const keys = keysUsed();
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('submitting the same prompt again after it succeeded is new work, not a replay', async () => {
    const store = make();
    await store.create({ ...request });
    await store.create({ ...request });

    const keys = keysUsed();
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('a double click shares the in-flight request instead of sending a second', async () => {
    const store = make();
    let release: (value: unknown) => void = () => {};
    apiMock.post.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    const first = store.create({ ...request });
    const second = store.create({ ...request });
    release({ items: [gen('a', 'pending')], credits: 100 });

    expect(await first).toEqual(await second);
    expect(apiMock.post).toHaveBeenCalledTimes(1);
  });
});
