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

  it('starts at zero and takes server-pushed balances', () => {
    const ledger = TestBed.inject(LedgerService);
    expect(ledger.balanceUsd()).toBe(0);
    ledger.setBalance(14.42);
    expect(ledger.balanceUsd()).toBe(14.42);
  });

  it('loads entries from GET /ledger', async () => {
    apiMock.get.mockResolvedValue({
      entries: [
        { id: '1', type: 'topup', amountUsd: 20, familyId: null, note: null, createdAt: 'now' },
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
    ledger.setBalance(5);
    await ledger.loadEntries();
    ledger.reset();
    expect(ledger.balanceUsd()).toBe(0);
    expect(ledger.entries().length).toBe(0);
    expect(ledger.entriesLoaded()).toBe(false);
  });
});
