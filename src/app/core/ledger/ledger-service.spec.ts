import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiService } from '../api/api-service';
import { LedgerService } from './ledger-service';

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
    expect(apiMock.get).toHaveBeenCalledWith('/ledger');
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
