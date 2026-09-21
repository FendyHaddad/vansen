import { describe, expect, it } from 'vitest';
import { SelectionStamp, StampedSelection, stampMatches, usableMask } from './selection-stamp';

function selection(over: Partial<StampedSelection> = {}): StampedSelection {
  const width = over.width ?? 4;
  const height = over.height ?? 4;
  return {
    token: 1,
    revision: 2,
    width,
    height,
    mask: over.mask ?? new Uint8Array(width * height),
    ...over,
  };
}

const now = (over: Partial<SelectionStamp> = {}): SelectionStamp => ({
  token: 1,
  revision: 2,
  width: 4,
  height: 4,
  ...over,
});

describe('selection stamps', () => {
  it('a mask taken from the pixels on screen is usable', () => {
    expect(usableMask(selection(), now())).not.toBeNull();
    expect(stampMatches(selection(), now())).toBe(true);
  });

  it('R13: a committed edit invalidates the mask', () => {
    // Undo, redo, a filter, a straighten — all bump the revision.
    expect(usableMask(selection(), now({ revision: 3 }))).toBeNull();
  });

  it('R13: opening another image invalidates the mask', () => {
    // Both images can be the same size, so only the token separates them.
    expect(usableMask(selection(), now({ token: 2 }))).toBeNull();
  });

  it('R13: a crop to a different shape invalidates the mask', () => {
    expect(usableMask(selection(), now({ width: 3 }))).toBeNull();
  });

  it('R13: a 90-degree rotation invalidates the mask', () => {
    // 8x4 → 4x8 keeps the pixel count identical; the length check alone
    // would let this through and erase the wrong region.
    const rotated = selection({ width: 8, height: 4 });
    expect(usableMask(rotated, now({ width: 4, height: 8 }))).toBeNull();
  });

  it('a mask whose length does not match the pixels is refused', () => {
    const wrong = selection({ mask: new Uint8Array(9) });
    expect(usableMask(wrong, now())).toBeNull();
  });

  it('no selection and no image are simply nothing to do', () => {
    expect(usableMask(null, now())).toBeNull();
    expect(usableMask(selection(), null)).toBeNull();
  });
});
