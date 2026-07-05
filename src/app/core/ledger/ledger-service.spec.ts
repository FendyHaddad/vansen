import { beforeEach, describe, expect, it } from 'vitest';
import { LedgerService } from './ledger-service';

describe('LedgerService', () => {
  beforeEach(() => localStorage.clear());

  it('seeds first topup once', () => {
    const l = new LedgerService();
    l.seedIfEmpty();
    l.seedIfEmpty();
    expect(l.balanceUsd()).toBeCloseTo(15);
    expect(l.entries().length).toBe(2);
  });

  it('charge debits and refuses overdraft', () => {
    const l = new LedgerService();
    l.seedIfEmpty();
    expect(l.charge('generate', 0.1, 'nano-banana')).toBe(true);
    expect(l.balanceUsd()).toBeCloseTo(14.9);
    expect(l.charge('generate', 999)).toBe(false);
    expect(l.balanceUsd()).toBeCloseTo(14.9);
  });

  it('restores from localStorage', () => {
    const a = new LedgerService();
    a.seedIfEmpty();
    a.charge('generate', 1);
    const b = new LedgerService();
    expect(b.balanceUsd()).toBeCloseTo(14);
  });

  it('reset clears everything', () => {
    const l = new LedgerService();
    l.seedIfEmpty();
    l.reset();
    expect(l.entries().length).toBe(0);
    expect(new LedgerService().entries().length).toBe(0);
  });
});
