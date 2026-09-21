import { afterEach, describe, expect, it } from 'vitest';
import { focusFirst, focusables, trapTab } from './focus-trap';

function dialog(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

const THREE = `
  <button id="a">A</button>
  <input id="b" />
  <button id="c">C</button>
`;

function tab(root: HTMLElement, shiftKey = false): boolean {
  return trapTab(root, new KeyboardEvent('keydown', { key: 'Tab', shiftKey }));
}

describe('focus trap', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('lists focusable children in document order', () => {
    const root = dialog(THREE);
    expect(focusables(root).map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });

  it('skips disabled controls', () => {
    // Landing on one puts the caret somewhere with no visible ring and no way
    // to act, which reads as the dialog having swallowed the keyboard.
    const root = dialog('<button id="a">A</button><button id="b" disabled>B</button>');
    expect(focusables(root).map((e) => e.id)).toEqual(['a']);
  });

  it('skips explicitly hidden children', () => {
    const root = dialog('<button id="a">A</button><button id="b" hidden>B</button>');
    expect(focusables(root).map((e) => e.id)).toEqual(['a']);
  });

  it('skips tabindex="-1", which is not in the Tab ring', () => {
    const root = dialog('<button id="a">A</button><div id="b" tabindex="-1">B</div>');
    expect(focusables(root).map((e) => e.id)).toEqual(['a']);
  });

  it('focuses the first child when opened', () => {
    const root = dialog(THREE);
    focusFirst(root);
    expect(document.activeElement?.id).toBe('a');
  });

  it('focuses the container itself when there is nothing inside to focus', () => {
    // A dialog that never takes focus leaves the screen reader reading the
    // page behind it.
    const root = dialog('<p>Nothing here</p>');
    focusFirst(root);
    expect(document.activeElement).toBe(root);
    expect(root.getAttribute('tabindex')).toBe('-1');
  });

  it('wraps forwards from the last child', () => {
    const root = dialog(THREE);
    root.querySelector<HTMLElement>('#c')!.focus();
    expect(tab(root)).toBe(true);
    expect(document.activeElement?.id).toBe('a');
  });

  it('wraps backwards from the first child', () => {
    const root = dialog(THREE);
    root.querySelector<HTMLElement>('#a')!.focus();
    expect(tab(root, true)).toBe(true);
    expect(document.activeElement?.id).toBe('c');
  });

  it('leaves Tab alone in the middle of the ring', () => {
    // The browser's own order is better than anything re-implemented here.
    const root = dialog(THREE);
    root.querySelector<HTMLElement>('#b')!.focus();
    expect(tab(root)).toBe(false);
    expect(document.activeElement?.id).toBe('b');
  });

  it('pulls focus back when it has escaped the dialog', () => {
    const root = dialog(THREE);
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    expect(tab(root)).toBe(true);
    expect(document.activeElement?.id).toBe('a');
  });

  it('pulls focus back to the end on Shift+Tab from outside', () => {
    const root = dialog(THREE);
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    expect(tab(root, true)).toBe(true);
    expect(document.activeElement?.id).toBe('c');
  });

  it('ignores keys that are not Tab', () => {
    const root = dialog(THREE);
    expect(trapTab(root, new KeyboardEvent('keydown', { key: 'a' }))).toBe(false);
  });

  it('does nothing when there is nothing to trap', () => {
    const root = dialog('<p>Nothing here</p>');
    expect(tab(root)).toBe(false);
  });
});
