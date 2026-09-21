/**
 * Keyboard containment for a modal, as pure functions over an element.
 *
 * Kept free of Angular so it can be tested against a plain DOM node, and so
 * the seven hand-rolled dialogs in this app end up sharing one implementation
 * instead of seven near-misses.
 */

/**
 * Anything the browser will move focus to, in document order.
 *
 * Hidden and disabled elements are excluded: a trap that lands on one is worse
 * than no trap, because the caret disappears with nothing visible to show for
 * it. `tabindex="-1"` is programmatically focusable but not in the Tab ring,
 * so it is excluded too.
 */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'video[controls]',
  'audio[controls]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(visible);
}

function visible(el: HTMLElement): boolean {
  if (el.hasAttribute('hidden')) return false;
  if (el.getAttribute('aria-hidden') === 'true') return false;
  // offsetParent is null for display:none. In jsdom every element reports
  // null, so treat that as visible rather than trapping nothing at all.
  const rects = el.getClientRects?.();
  return !rects || rects.length > 0 || el.offsetParent !== null || !el.style.display;
}

/** Focus the first thing inside, or the container itself if it is empty. */
export function focusFirst(root: HTMLElement): void {
  const first = focusables(root)[0];
  if (first) {
    first.focus();
    return;
  }
  // A dialog with nothing focusable still has to receive focus, or the screen
  // reader keeps reading the page behind it.
  if (!root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1');
  root.focus();
}

/**
 * Wrap Tab at the edges. Returns true when it moved focus, so the caller knows
 * to call preventDefault.
 */
export function trapTab(root: HTMLElement, event: KeyboardEvent): boolean {
  if (event.key !== 'Tab') return false;
  const ring = focusables(root);
  if (ring.length === 0) return false;

  const first = ring[0];
  const last = ring[ring.length - 1];
  const active = document.activeElement as HTMLElement | null;

  // Focus escaped the dialog entirely (a click on the page behind, say).
  // Pull it back rather than letting Tab walk further away.
  if (!active || !root.contains(active)) {
    (event.shiftKey ? last : first).focus();
    return true;
  }
  if (event.shiftKey && active === first) {
    last.focus();
    return true;
  }
  if (!event.shiftKey && active === last) {
    first.focus();
    return true;
  }
  return false;
}
