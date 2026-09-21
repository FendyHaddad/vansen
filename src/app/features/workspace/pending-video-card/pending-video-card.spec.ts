import { TestBed } from '@angular/core/testing';
import type { GenerationItem } from '../../../core/generations/generation-store';
import {
  RELEASE_CAPABILITIES,
  type ReleaseCapabilityManifest,
} from '../../../core/release/release-capabilities';
import { PendingVideoCard, backgroundNote, easedProgress, phaseLabel } from './pending-video-card';

const started = Date.parse('2026-09-06T10:00:00Z');

function pending(job: Partial<GenerationItem['job']> = {}): GenerationItem {
  return {
    id: 'v1', kind: 'video', familyId: 'veo', familyName: 'Veo 3.1', op: 'generate', prompt: 'p', settings: { aspectRatio: '16:9', durationS: 8 },
    priceCredits: 534, status: 'pending', mediaUrl: '', parentId: null, createdAt: new Date(started).toISOString(),
    job: { cancellable: true, expectedS: 96, startedAt: new Date(started).toISOString(), phase: 'rendering', ...job },
  } as GenerationItem;
}

describe('pending video helpers', () => {
  it('easedProgress climbs to 0.9 and never beyond without a report', () => {
    expect(easedProgress(0, 96)).toBe(0);
    expect(easedProgress(48, 96)).toBeGreaterThan(0.4);
    expect(easedProgress(48, 96)).toBeLessThan(0.9);
    expect(easedProgress(500, 96)).toBe(0.9);
    expect(easedProgress(10, 96, 0.95)).toBe(0.95);
  });

  it('phaseLabel', () => {
    expect(phaseLabel('queued', 5, 96)).toBe('Queued');
    expect(phaseLabel('rendering', 5, 96)).toBe('Rendering');
    expect(phaseLabel('rendering', 100, 96)).toBe('Almost there…');
    expect(phaseLabel('rendering', 200, 96)).toBe('Taking longer than usual — still working.');
    expect(phaseLabel('saving', 300, 96)).toBe('Saving');
  });
});

describe('background-completion copy', () => {
  function noteFor(manifest: ReleaseCapabilityManifest | null): string {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: RELEASE_CAPABILITIES, useValue: manifest }],
    });
    const fixture = TestBed.createComponent(PendingVideoCard);
    fixture.componentRef.setInput('item', pending());
    fixture.componentRef.setInput('now', started + 1000);
    fixture.detectChanges();
    return (fixture.nativeElement as HTMLElement).querySelector('.pv-note')!.textContent!.trim();
  }

  it('promises nothing when the manifest is missing or unreachable', () => {
    expect(noteFor(null)).toBe('Keep this page open while it renders.');
  });

  it('promises nothing when background completion is not verified', () => {
    expect(noteFor({ backgroundCompletion: false, completionNotifications: true }))
      .toBe('Keep this page open while it renders.');
  });

  it('allows leave-and-return once background completion is verified', () => {
    expect(noteFor({ backgroundCompletion: true }))
      .toBe('You can leave this page and return to check the result.');
  });

  it('allows notification wording only when BOTH are verified', () => {
    expect(noteFor({ backgroundCompletion: true, completionNotifications: true }))
      .toBe("You can leave this page. We'll notify you when it's ready.");
  });

  it('never promises notifications on background completion alone', () => {
    // D6 stays unavailable until delivery is proven on the device, whatever
    // the worker can do.
    expect(backgroundNote(true, false)).not.toContain('notify');
    expect(backgroundNote(false, false)).not.toContain('notify');
  });
});

describe('PendingVideoCard', () => {
  function make(item: GenerationItem, nowMs: number) {
    const fixture = TestBed.createComponent(PendingVideoCard);
    fixture.componentRef.setInput('item', item);
    fixture.componentRef.setInput('now', nowMs);
    fixture.detectChanges();
    return fixture;
  }

  it('shows phase, eased bar and a note', () => {
    const fixture = make(pending(), started + 48_000);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.pv-phase')!.textContent).toContain('Rendering');
    expect(el.querySelector('.pv-note')!.textContent).toContain('Keep this page open');
    const bar = el.querySelector('.pv-bar-fill') as HTMLElement;
    expect(bar.style.getPropertyValue('--p')).not.toBe('');
  });

  it('shows queue position and hides cancel when not cancellable', () => {
    const fixture = make(pending({ phase: 'queued', queuePosition: 4, cancellable: false }), started + 1000);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.pv-phase')!.textContent).toContain('4 ahead');
    expect(el.querySelector('.pv-cancel')).toBeNull();
  });

  it('emits cancel', () => {
    const fixture = make(pending(), started + 1000);
    const ids: string[] = [];
    fixture.componentInstance.cancel.subscribe((id) => ids.push(id));
    (fixture.nativeElement.querySelector('.pv-cancel') as HTMLButtonElement).click();
    expect(ids).toEqual(['v1']);
  });
});
