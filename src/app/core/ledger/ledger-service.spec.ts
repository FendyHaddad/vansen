import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiService } from '../api/api-service';
import { LedgerService, MAX_MONTH_PAGES } from './ledger-service';

describe('LedgerService', () => {
  const apiMock = { get: vi.fn() };

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: ApiService, useValue: apiMock }],
    });
    apiMock.get.mockReset();
  });

  it('starts at zero and exposes bucket balances and total', () => {
    const ledger = TestBed.inject(LedgerService);
    expect(ledger.totalCredits()).toBe(0);
    ledger.setCredits({ plan: 1200, pack: 300 });
    expect(ledger.planCredits()).toBe(1200);
    expect(ledger.packCredits()).toBe(300);
    expect(ledger.totalCredits()).toBe(1500);
  });

  it('loads entries from GET /ledger', async () => {
    apiMock.get.mockResolvedValue({
      entries: [
        {
          id: '1',
          type: 'cycle_reset',
          amountCredits: 1500,
          bucket: 'plan',
          familyId: null,
          note: null,
          createdAt: 'now',
        },
      ],
    });
    const ledger = TestBed.inject(LedgerService);
    await ledger.loadEntries();
    expect(apiMock.get).toHaveBeenCalledWith('/ledger?limit=50');
    expect(ledger.entries().length).toBe(1);
    expect(ledger.entriesLoaded()).toBe(true);
  });

  it('reset clears everything', async () => {
    apiMock.get.mockResolvedValue({ entries: [] });
    const ledger = TestBed.inject(LedgerService);
    ledger.setCredits({ plan: 5, pack: 5 });
    await ledger.loadEntries();
    ledger.reset();
    expect(ledger.totalCredits()).toBe(0);
    expect(ledger.entries().length).toBe(0);
    expect(ledger.entriesLoaded()).toBe(false);
  });
});

/** R16: the ledger used to stop at 100 entries and say nothing about it. */
describe('LedgerService paging', () => {
  const apiMock = { get: vi.fn() };

  function entry(id: string) {
    return {
      id,
      type: 'spend',
      amountCredits: -40,
      bucket: 'plan',
      familyId: 'flux',
      note: null,
      createdAt: '2026-01-01T00:00:00Z',
    };
  }

  function make(): LedgerService {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: ApiService, useValue: apiMock }],
    });
    return TestBed.inject(LedgerService);
  }

  beforeEach(() => apiMock.get.mockReset());

  it('reports more history when the server offers a cursor', async () => {
    apiMock.get.mockResolvedValue({ entries: [entry('a')], nextCursor: 'c1' });
    const ledger = make();
    await ledger.loadEntries();
    expect(ledger.hasMore()).toBe(true);
  });

  it('appends the next page and de-duplicates the seam', async () => {
    apiMock.get.mockResolvedValueOnce({ entries: [entry('a'), entry('b')], nextCursor: 'c1' });
    const ledger = make();
    await ledger.loadEntries();

    apiMock.get.mockResolvedValueOnce({ entries: [entry('b'), entry('c')], nextCursor: null });
    await ledger.loadMoreEntries();

    expect(ledger.entries().map((e) => e.id)).toEqual(['a', 'b', 'c']);
    expect(ledger.hasMore()).toBe(false);
  });

  it('a second loadMore at the end asks for nothing', async () => {
    apiMock.get.mockResolvedValueOnce({ entries: [entry('a')], nextCursor: null });
    const ledger = make();
    await ledger.loadEntries();
    apiMock.get.mockClear();

    await ledger.loadMoreEntries();
    expect(apiMock.get).not.toHaveBeenCalled();
  });
});

/** The usage tab sums this month; one 50-entry page undercounts a busy month. */
describe('LedgerService current month', () => {
  const apiMock = { get: vi.fn() };
  const now = new Date(2026, 8, 15);

  function entry(id: string, createdAt: Date) {
    return {
      id,
      type: 'generate',
      amountCredits: -10,
      bucket: 'plan',
      familyId: 'flux',
      note: null,
      createdAt: createdAt.toISOString(),
    };
  }

  function make(): LedgerService {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: ApiService, useValue: apiMock }],
    });
    return TestBed.inject(LedgerService);
  }

  beforeEach(() => apiMock.get.mockReset());

  it('pages until an entry predates the start of the month', async () => {
    apiMock.get
      .mockResolvedValueOnce({ entries: [entry('a', new Date(2026, 8, 14))], nextCursor: 'c1' })
      .mockResolvedValueOnce({ entries: [entry('b', new Date(2026, 8, 3))], nextCursor: 'c2' })
      .mockResolvedValueOnce({
        entries: [entry('c', new Date(2026, 8, 1, 0, 5)), entry('d', new Date(2026, 7, 31))],
        nextCursor: 'c3',
      });
    const ledger = make();
    await ledger.loadCurrentMonth(now);
    expect(apiMock.get).toHaveBeenCalledTimes(3);
    expect(ledger.entries().map((e) => e.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('stops when the server has no more pages', async () => {
    apiMock.get.mockResolvedValueOnce({
      entries: [entry('a', new Date(2026, 8, 14))],
      nextCursor: null,
    });
    const ledger = make();
    await ledger.loadCurrentMonth(now);
    expect(apiMock.get).toHaveBeenCalledTimes(1);
    expect(ledger.entriesLoaded()).toBe(true);
  });

  it('continues from entries another tab already loaded', async () => {
    apiMock.get.mockResolvedValueOnce({
      entries: [entry('a', new Date(2026, 8, 14))],
      nextCursor: 'c1',
    });
    const ledger = make();
    await ledger.loadEntries();
    apiMock.get.mockClear();
    apiMock.get.mockResolvedValueOnce({
      entries: [entry('b', new Date(2026, 7, 20))],
      nextCursor: 'c2',
    });
    await ledger.loadCurrentMonth(now);
    expect(apiMock.get).toHaveBeenCalledTimes(1);
    expect(apiMock.get).toHaveBeenCalledWith('/ledger?limit=50&cursor=c1');
  });

  it('caps pages defensively against a server that never stops', async () => {
    let page = 0;
    apiMock.get.mockImplementation(async () => {
      page += 1;
      return { entries: [entry(`e${page}`, new Date(2026, 8, 14))], nextCursor: `n${page}` };
    });
    const ledger = make();
    await ledger.loadCurrentMonth(now);
    expect(apiMock.get).toHaveBeenCalledTimes(MAX_MONTH_PAGES);
  });
});
