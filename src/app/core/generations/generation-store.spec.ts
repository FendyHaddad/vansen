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

/**
 * R16: the library pages. Everything below is about the seams between pages —
 * where the old code either lost rows or showed them twice.
 */
describe('GenerationStore paging', () => {
  const apiMock = { get: vi.fn(), post: vi.fn(), postForm: vi.fn(), delete: vi.fn() };
  const ledgerMock = { setCredits: vi.fn() };
  const mediaMock = { evict: vi.fn() };
  const profileMock = { load: vi.fn().mockResolvedValue(undefined) };
  const notifMock = { addMany: vi.fn() };

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

  function page(ids: string[], nextCursor: string | null) {
    // A list page carries a thumbnail and no original — that is the shape the
    // server now returns.
    return {
      items: ids.map((id) => ({ ...gen(id, 'done'), thumbUrl: `https://t/${id}.jpg` })),
      nextCursor,
    };
  }

  function full(id: string): GenerationDto {
    return { ...gen(id, 'done'), mediaUrl: `https://m/${id}.png` };
  }

  beforeEach(() => {
    localStorage.clear();
    apiMock.get.mockReset();
    notifMock.addMany.mockReset();
  });

  it('load takes the first page and reports there is more', async () => {
    apiMock.get.mockResolvedValue(page(['a', 'b'], 'cursor-1'));
    const store = make();
    await store.load();

    expect(store.items().map((i) => i.id)).toEqual(['a', 'b']);
    expect(store.hasMore()).toBe(true);
    expect(apiMock.get.mock.calls[0][0]).toContain('limit=');
  });

  it('loadMore appends without duplicating', async () => {
    apiMock.get.mockResolvedValueOnce(page(['a', 'b'], 'cursor-1'));
    const store = make();
    await store.load();

    // 'b' appears again on the second page — a row written between the two
    // reads shifts the seam, and the server is allowed to repeat one.
    apiMock.get.mockResolvedValueOnce(page(['b', 'c'], null));
    await store.loadMore();

    expect(store.items().map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect(store.hasMore()).toBe(false);
  });

  it('a loadMore past the end asks for nothing', async () => {
    apiMock.get.mockResolvedValueOnce(page(['a'], null));
    const store = make();
    await store.load();
    apiMock.get.mockClear();

    await store.loadMore();
    expect(apiMock.get).not.toHaveBeenCalled();
  });

  it('a refresh during a loadMore does not interleave the two reads', async () => {
    apiMock.get.mockResolvedValueOnce(page(['a', 'b'], 'cursor-1'));
    const store = make();
    await store.load();

    let releasePage: (v: unknown) => void = () => {};
    apiMock.get.mockImplementationOnce(
      () => new Promise((resolve) => (releasePage = resolve)),
    );
    const slowPage = store.loadMore();

    // The whole library is re-read while page two is still in the air.
    apiMock.get.mockResolvedValueOnce(page(['x', 'y'], null));
    await store.load();

    releasePage(page(['c', 'd'], null));
    await slowPage;

    expect(store.items().map((i) => i.id)).toEqual(['x', 'y']);
  });

  it('only the first page is snapshotted to local storage', async () => {
    const many = Array.from({ length: 120 }, (_, i) => `g${i}`);
    apiMock.get.mockResolvedValue(page(many, null));
    const store = make();
    await store.load();
    // persist() resolves the user id first, so the write lands a turn later.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const key = Object.keys(localStorage).find((k) => k.includes('generations'));
    expect(key).toBeDefined();
    const cached = JSON.parse(localStorage.getItem(key!)!).value as unknown[];
    // 120 rows in memory, 50 on disk: the snapshot is a head start, not a
    // mirror, and a mirror is what blows the quota.
    expect(store.items().length).toBe(120);
    expect(cached.length).toBe(50);
  });

  it('fetchById reaches past the loaded pages for an old item', async () => {
    apiMock.get.mockResolvedValueOnce(page(['a'], 'cursor-1'));
    const store = make();
    await store.load();

    apiMock.get.mockResolvedValueOnce({ item: full('old') });
    const found = await store.fetchById('old');

    expect(found?.id).toBe('old');
    expect(store.byId('old')?.id).toBe('old');
  });

  it('fetchById does not ask the server for a row it already has in full', async () => {
    apiMock.get.mockResolvedValueOnce({ items: [full('a')], nextCursor: null });
    const store = make();
    await store.load();
    apiMock.get.mockClear();

    expect((await store.fetchById('a'))?.id).toBe('a');
    expect(apiMock.get).not.toHaveBeenCalled();
  });

  it('fetchById gets the original for a row the grid only has a tile of', async () => {
    apiMock.get.mockResolvedValueOnce(page(['a'], null));
    const store = make();
    await store.load();
    expect(store.byId('a')?.mediaUrl).toBe('');

    apiMock.get.mockResolvedValueOnce({ item: full('a') });
    const found = await store.fetchById('a');

    expect(found?.mediaUrl).toBe('https://m/a.png');
    // Swapped in place, not appended: the grid must not grow a second tile.
    expect(store.items().filter((i) => i.id === 'a').length).toBe(1);
  });

  it('loadChain takes the whole version chain from the server', async () => {
    apiMock.get.mockResolvedValueOnce(page(['newest'], 'cursor-1'));
    const store = make();
    await store.load();

    // The root is thousands of rows back; nothing loaded knows about it.
    apiMock.get.mockResolvedValueOnce(page(['root', 'v2', 'newest'], null));
    const chain = await store.loadChain('newest');

    expect(chain.map((i) => i.id)).toEqual(['root', 'v2', 'newest']);
    expect(store.byId('root')?.id).toBe('root');
    expect(store.items().filter((i) => i.id === 'newest').length).toBe(1);
  });

  it('a sign-out mid-page drops the page that was in the air', async () => {
    apiMock.get.mockResolvedValueOnce(page(['a'], 'cursor-1'));
    const store = make();
    await store.load();

    let releasePage: (v: unknown) => void = () => {};
    apiMock.get.mockImplementationOnce(
      () => new Promise((resolve) => (releasePage = resolve)),
    );
    const inFlight = store.loadMore();
    store.reset();
    releasePage(page(['b'], null));
    await inFlight;

    expect(store.items()).toEqual([]);
  });
});

/**
 * R15: retry and variation are server operations.
 *
 * The client used to rebuild the request from the fields it happened to still
 * hold, which was never all of them. It now names the generation and lets the
 * server replay its own snapshot.
 */
describe('GenerationStore retry and variation', () => {
  const apiMock = { get: vi.fn(), post: vi.fn(), postForm: vi.fn(), delete: vi.fn() };
  const ledgerMock = { setCredits: vi.fn() };
  const mediaMock = { evict: vi.fn() };
  const profileMock = { load: vi.fn().mockResolvedValue(undefined) };
  const notifMock = { addMany: vi.fn() };

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

  beforeEach(() => {
    localStorage.clear();
    apiMock.post.mockReset();
    apiMock.get.mockReset();
    ledgerMock.setCredits.mockReset();
    apiMock.post.mockResolvedValue({ items: [gen('new', 'pending')], credits: { plan: 10, pack: 0 } });
  });

  it('asks the server to retry by id, sending no request fields of its own', async () => {
    const store = make();
    await store.retry('g1');

    const [path, body] = apiMock.post.mock.calls[0];
    expect(path).toBe('/generations/g1/retry');
    // Anything sent here would be the client guessing again.
    expect(body).toEqual({});
  });

  it('gives each retry its own submission identity', async () => {
    const store = make();
    await store.retry('g1');
    await store.retry('g1');

    const first = apiMock.post.mock.calls[0][2].idempotencyKey;
    const second = apiMock.post.mock.calls[1][2].idempotencyKey;
    expect(first).toBeTruthy();
    // A retry is new work, not a replay of the previous attempt.
    expect(second).not.toBe(first);
  });

  it('asks the server to vary by id', async () => {
    const store = make();
    await store.variation('g1');
    expect(apiMock.post.mock.calls[0][0]).toBe('/generations/g1/variation');
  });

  it('puts the new items at the top and updates the balance', async () => {
    const store = make();
    await store.retry('g1');

    expect(store.items().map((i) => i.id)).toEqual(['new']);
    expect(ledgerMock.setCredits).toHaveBeenCalledWith({ plan: 10, pack: 0 });
  });

  it('a refusal changes nothing in the library', async () => {
    const store = make();
    apiMock.post.mockRejectedValue(new Error('refused'));

    await expect(store.retry('g1')).rejects.toThrow();
    expect(store.items()).toEqual([]);
    expect(ledgerMock.setCredits).not.toHaveBeenCalled();
  });

  it('reads the retryable probe from the server', async () => {
    const store = make();
    apiMock.get.mockResolvedValue({ retry: false, variation: false, reason: 'gone' });

    const answer = await store.retryable('g1');
    expect(apiMock.get.mock.calls[0][0]).toBe('/generations/g1/retryable');
    expect(answer.reason).toBe('gone');
  });
});
