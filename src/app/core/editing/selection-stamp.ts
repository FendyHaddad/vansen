/**
 * A selection mask describes one image at one moment.
 *
 * It is a per-pixel map, so a crop, a rotation, an undo, a committed edit or
 * a different image all make it meaningless. Applying a stale one either
 * throws on a length mismatch or — the reason this file exists — quietly
 * erases whatever now occupies those coordinates.
 */
export interface SelectionStamp {
  /** Which opening of the editor produced it. */
  token: number;
  /** Which committed state of that opening produced it. */
  revision: number;
  width: number;
  height: number;
}

export interface StampedSelection extends SelectionStamp {
  mask: Uint8Array;
}

export function stampMatches(stamp: SelectionStamp, now: SelectionStamp): boolean {
  return (
    stamp.token === now.token &&
    stamp.revision === now.revision &&
    stamp.width === now.width &&
    stamp.height === now.height
  );
}

/**
 * The mask, or null when it can no longer be trusted. Checked BEFORE any
 * allocation or model call — a mismatch is a question for the customer, not
 * an exception halfway through an inpaint.
 */
export function usableMask(
  selection: StampedSelection | null,
  now: SelectionStamp | null,
): Uint8Array | null {
  if (!selection || !now) return null;
  if (!stampMatches(selection, now)) return null;
  // Same dimensions, wrong length: the mask was built for something else.
  if (selection.mask.length !== now.width * now.height) return null;
  return selection.mask;
}
