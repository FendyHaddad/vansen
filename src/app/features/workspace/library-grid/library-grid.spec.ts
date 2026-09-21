import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { LibraryGrid } from './library-grid';
import { MediaCache } from '../../../core/media/media-cache';
import { PosterService } from '../../../core/media/poster-service';
import { GenerationDto } from '../../../core/api/dtos';

function failed(over: Partial<GenerationDto> = {}): GenerationDto {
  return {
    id: 'g1',
    kind: 'video',
    familyId: 'kling',
    familyName: 'Kling 3.0 Pro',
    op: 'generate',
    prompt: 'a cat walks',
    settings: {},
    priceCredits: 40,
    status: 'failed',
    mediaUrl: '',
    parentId: null,
    createdAt: '2026-09-20T00:00:00Z',
    ...over,
  } as GenerationDto;
}

function make(items: GenerationDto[]): ComponentFixture<LibraryGrid> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [LibraryGrid],
    providers: [
      { provide: MediaCache, useValue: { objectUrl: () => Promise.resolve('') } },
      { provide: PosterService, useValue: { ensure: () => undefined, urlFor: () => null } },
    ],
  });
  const fixture = TestBed.createComponent(LibraryGrid);
  fixture.componentRef.setInput('items', items);
  fixture.detectChanges();
  return fixture;
}

/**
 * R24: a cancelled video still reads "Cancelled · Refunded" after a reload.
 *
 * Cancellation used to be a client-side patch on the in-memory item, so a
 * reload turned the customer's own cancellation into "Generation failed" with
 * a Retry button for something they had deliberately stopped. The server now
 * persists the reason and sends it as `failure`.
 */
describe('LibraryGrid cancelled vs failed', () => {
  let text: (f: ComponentFixture<LibraryGrid>) => string;

  beforeEach(() => {
    text = (f) => f.nativeElement.textContent as string;
  });

  it('renders a server-reported cancellation as cancelled', () => {
    const fixture = make([
      failed({ failure: { code: 'cancelled', message: 'Cancelled · Refunded', cancelled: true } }),
    ]);
    expect(text(fixture)).toContain('Cancelled');
    expect(text(fixture)).not.toContain('Generation failed');
  });

  it('offers no retry for something the customer stopped on purpose', () => {
    const fixture = make([
      failed({ failure: { code: 'cancelled', message: 'Cancelled · Refunded', cancelled: true } }),
    ]);
    const retry = [...fixture.nativeElement.querySelectorAll('button')].find((b) =>
      (b as HTMLElement).textContent?.includes('Retry'),
    );
    expect(retry).toBeUndefined();
  });

  it('renders a provider failure as a failure, with a retry', () => {
    const fixture = make([
      failed({
        failure: {
          code: 'provider_error',
          message: 'Generation failed. Your credits were refunded.',
          cancelled: false,
        },
      }),
    ]);
    expect(text(fixture)).toContain('Generation failed');
    const retry = [...fixture.nativeElement.querySelectorAll('button')].find((b) =>
      (b as HTMLElement).textContent?.includes('Retry'),
    );
    expect(retry).toBeTruthy();
  });

  it('still honours the older `error` signal for rows settled before P8', () => {
    const fixture = make([failed({ error: 'cancelled' })]);
    expect(text(fixture)).toContain('Cancelled');
  });

  it('the server answer wins over a stale error string', () => {
    const fixture = make([
      failed({
        error: 'cancelled',
        failure: {
          code: 'provider_error',
          message: 'Generation failed. Your credits were refunded.',
          cancelled: false,
        },
      }),
    ]);
    expect(text(fixture)).toContain('Generation failed');
  });
});

/**
 * R26: the library is operable without a mouse.
 *
 * Every tile was a `<figure>` with a click handler and no `tabindex`, `role`
 * or key binding, so a keyboard user could not open a single generation. The
 * variation button was the one quick action with no label, so it announced as
 * "button".
 */
describe('R26: the library grid is keyboard-operable', () => {
  const item = (over: Partial<GenerationDto> = {}) =>
    failed({ status: 'done', mediaUrl: 'https://m/1.png', kind: 'image', ...over });

  it('every interactive element in the grid has an accessible name', () => {
    const fixture = make([item()]);
    const nodes = fixture.nativeElement.querySelectorAll('button, [role="button"]');
    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes) {
      const name = node.getAttribute('aria-label') || node.textContent?.trim();
      expect(name, node.outerHTML.slice(0, 120)).toBeTruthy();
    }
  });

  it('puts every card in the tab order', () => {
    const fixture = make([item(), item({ id: 'g2' })]);
    const cards = fixture.nativeElement.querySelectorAll('.gen-card');
    expect(cards.length).toBe(2);
    for (const card of cards) {
      expect(card.getAttribute('tabindex')).toBe('0');
      expect(card.getAttribute('role')).toBe('button');
    }
  });

  it('names a card by its prompt, not by its type alone', () => {
    const fixture = make([item({ prompt: 'a lighthouse at dawn' })]);
    const card = fixture.nativeElement.querySelector('.gen-card') as HTMLElement;
    expect(card.getAttribute('aria-label')).toContain('a lighthouse at dawn');
    expect(card.getAttribute('aria-label')).toContain('Image');
  });

  it('says so when a card is not finished', () => {
    const fixture = make([item({ status: 'pending' })]);
    const card = fixture.nativeElement.querySelector('.gen-card') as HTMLElement;
    expect(card.getAttribute('aria-label')).toContain('pending');
  });

  it('truncates a long prompt rather than reading an essay', () => {
    const fixture = make([item({ prompt: 'x'.repeat(400) })]);
    const label = fixture.nativeElement.querySelector('.gen-card')!.getAttribute('aria-label');
    expect(label!.length).toBeLessThan(110);
  });

  it('opens a card with Enter', () => {
    const fixture = make([item()]);
    const opened: string[] = [];
    fixture.componentInstance.opened.subscribe((id: string) => opened.push(id));
    const card = fixture.nativeElement.querySelector('.gen-card') as HTMLElement;
    card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(opened).toEqual(['g1']);
  });

  it('opens a card with Space, without scrolling the page', () => {
    const fixture = make([item()]);
    const opened: string[] = [];
    fixture.componentInstance.opened.subscribe((id: string) => opened.push(id));
    const card = fixture.nativeElement.querySelector('.gen-card') as HTMLElement;
    const event = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    card.dispatchEvent(event);
    expect(opened).toEqual(['g1']);
    expect(event.defaultPrevented).toBe(true);
  });
});
