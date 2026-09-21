import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DetailOverlay } from './detail-overlay';
import { MediaCache } from '../../../core/media/media-cache';
import { GenerationDto } from '../../../core/api/dtos';

function videoItem(familyId: string): GenerationDto {
  return {
    id: 'v1',
    kind: 'video',
    familyId,
    familyName: familyId,
    op: 'generate',
    prompt: 'p',
    settings: { mode: 't2v', durationS: 8 },
    priceCredits: 100,
    status: 'done',
    mediaUrl: 'https://media/v1.mp4',
    parentId: null,
    createdAt: '2026-09-05T00:00:00Z',
  } as GenerationDto;
}

function make(item: GenerationDto): ComponentFixture<DetailOverlay> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [DetailOverlay],
    providers: [{ provide: MediaCache, useValue: { objectUrl: () => Promise.resolve('') } }],
  });
  const fixture = TestBed.createComponent(DetailOverlay);
  fixture.componentRef.setInput('item', item);
  return fixture;
}

describe('DetailOverlay canExtend', () => {
  it('is true for a clip whose own family supports extend', () => {
    expect(make(videoItem('veo')).componentInstance.canExtend()).toBe(true);
  });

  it('is false for a clip whose own family cannot extend', () => {
    expect(make(videoItem('kling')).componentInstance.canExtend()).toBe(false);
  });

  it('is false for an unknown family', () => {
    expect(make(videoItem('nope')).componentInstance.canExtend()).toBe(false);
  });
});

function failedImage(): GenerationDto {
  return {
    id: 'g1',
    kind: 'image',
    familyId: 'flux',
    familyName: 'FLUX',
    op: 'generate',
    prompt: 'a cat',
    settings: { aspectRatio: '1:1' },
    priceCredits: 5,
    status: 'failed',
    mediaUrl: '',
    parentId: null,
    createdAt: '2026-09-20T00:00:00Z',
  } as GenerationDto;
}

/**
 * R15: a control that cannot do what it says must not be offered.
 *
 * Retry used to be a button that always appeared and often 400'd — no mask,
 * no references, invalid_family. The server now says in advance whether it
 * can rebuild the request, and the button follows that answer.
 */
describe('DetailOverlay retry and variation affordances', () => {
  function withRetryable(
    item: GenerationDto,
    retryable: { retry: boolean; variation: boolean; reason?: string },
  ): ComponentFixture<DetailOverlay> {
    const fixture = make(item);
    fixture.componentRef.setInput('retryable', retryable);
    fixture.detectChanges();
    return fixture;
  }

  function button(fixture: ComponentFixture<DetailOverlay>, text: string): HTMLButtonElement {
    const all = [...fixture.nativeElement.querySelectorAll('button.action')];
    const found = all.find((b) => (b as HTMLElement).textContent?.includes(text));
    return found as HTMLButtonElement;
  }

  it('offers retry on a failed item the server can rebuild', () => {
    const fixture = withRetryable(failedImage(), { retry: true, variation: false });
    const retry = button(fixture, 'Retry');
    expect(retry).toBeTruthy();
    expect(retry.disabled).toBe(false);
    expect(retry.getAttribute('aria-label')).toBe('Retry this generation');
  });

  it('disables retry and says why when the server cannot rebuild it', () => {
    const reason = 'The reference image this used is no longer available.';
    const fixture = withRetryable(failedImage(), { retry: false, variation: false, reason });

    const retry = button(fixture, 'Retry');
    expect(retry.disabled).toBe(true);
    // The reason has to reach a screen reader, not just a tooltip.
    expect(retry.getAttribute('aria-label')).toBe(reason);
    expect(fixture.nativeElement.textContent).toContain(reason);
  });

  it('assumes nothing before the server answers', () => {
    // The probe is in flight when the overlay first paints.
    const fixture = make(failedImage());
    fixture.detectChanges();
    expect(button(fixture, 'Retry').disabled).toBe(true);
  });

  it('shows no retry control at all on a healthy item', () => {
    const done = { ...failedImage(), status: 'done' } as GenerationDto;
    const fixture = withRetryable(done, { retry: true, variation: true });
    expect(button(fixture, 'Retry')).toBeUndefined();
  });

  it('disables variation where a variation cannot mean anything', () => {
    const fixture = withRetryable(failedImage(), { retry: true, variation: false });
    const variation = button(fixture, 'Variation');
    expect(variation.disabled).toBe(true);
    expect(variation.getAttribute('aria-label')).toContain('generated images');
  });

  it('enables variation when the server allows it', () => {
    const done = { ...failedImage(), status: 'done' } as GenerationDto;
    const fixture = withRetryable(done, { retry: false, variation: true });
    expect(button(fixture, 'Variation').disabled).toBe(false);
  });
});

/**
 * R26: the detail overlay is a real dialog.
 *
 * It was a `<div class="panel">`: no role, no name, no focus management. A
 * screen reader announced nothing when it opened, Tab walked straight out of
 * it into the page behind, and closing it dropped the caret at the top of the
 * document — so a keyboard user had to tab all the way back to the tile they
 * had been on.
 */
describe('R26: the detail overlay is a real dialog', () => {
  let fixture: ComponentFixture<DetailOverlay>;
  let panel: HTMLElement;

  beforeEach(() => {
    fixture = make(videoItem('veo'));
    // The trap needs the fixture in the document to hold real focus.
    document.body.appendChild(fixture.nativeElement);
    fixture.detectChanges();
    panel = fixture.nativeElement.querySelector('.panel') as HTMLElement;
  });

  afterEach(() => {
    fixture.nativeElement.remove();
  });

  it('declares a dialog role and is modal', () => {
    expect(panel.getAttribute('role')).toBe('dialog');
    expect(panel.getAttribute('aria-modal')).toBe('true');
  });

  it('is labelled by its own content, not by nothing', () => {
    const labelledBy = panel.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(fixture.nativeElement.querySelector(`#${labelledBy}`)).toBeTruthy();
  });

  it('moves focus into the dialog when it opens', () => {
    expect(panel.contains(document.activeElement)).toBe(true);
  });

  it('keeps Tab inside the dialog', () => {
    const focusables = panel.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    focusables[focusables.length - 1].focus();
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(panel.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(focusables[0]);
  });

  it('wraps backwards too', () => {
    const focusables = panel.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    focusables[0].focus();
    panel.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }),
    );
    expect(document.activeElement).toBe(focusables[focusables.length - 1]);
  });

  it('restores focus to the opener on close', () => {
    // Otherwise a keyboard user is dropped at the top of the document and has
    // to tab all the way back to where they were.
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();

    const reopened = make(videoItem('veo'));
    document.body.appendChild(reopened.nativeElement);
    reopened.detectChanges();
    expect(document.activeElement).not.toBe(opener);

    reopened.destroy();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('Escape closes it', () => {
    const seen: unknown[] = [];
    fixture.componentInstance.closed.subscribe(() => seen.push(1));
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(seen.length).toBe(1);
  });
});
