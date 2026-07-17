import { describe, expect, it } from 'vitest';
import { computeAge, isAdult } from './age';

const at = (iso: string) => new Date(iso);

describe('computeAge', () => {
  it('is exactly 18 on the 18th birthday', () => {
    expect(computeAge('2008-07-17', at('2026-07-17T12:00:00Z'))).toBe(18);
    expect(isAdult('2008-07-17', at('2026-07-17T12:00:00Z'))).toBe(true);
  });

  it('is 17 the day before the 18th birthday', () => {
    expect(computeAge('2008-07-18', at('2026-07-17T12:00:00Z'))).toBe(17);
    expect(isAdult('2008-07-18', at('2026-07-17T12:00:00Z'))).toBe(false);
  });

  it('is 18 the day after the 18th birthday', () => {
    expect(computeAge('2008-07-16', at('2026-07-17T12:00:00Z'))).toBe(18);
  });

  it('handles a Feb-29 birth date in a non-leap year', () => {
    expect(computeAge('2008-02-29', at('2026-03-01T12:00:00Z'))).toBe(18);
    expect(computeAge('2008-02-29', at('2026-02-28T12:00:00Z'))).toBe(17);
  });
});
