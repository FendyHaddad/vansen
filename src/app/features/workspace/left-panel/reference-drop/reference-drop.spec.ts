import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { ApiService } from '../../../../core/api/api-service';
import type { VideoMode } from '../../../../core/catalog/model-families';
import { ReferenceDrop, type RefSlot } from './reference-drop';

describe('ReferenceDrop', () => {
  const api = { postForm: vi.fn() };

  function make(mode: string, slots: { path: string; url: string }[] = []) {
    TestBed.configureTestingModule({ providers: [{ provide: ApiService, useValue: api }] });
    const fixture = TestBed.createComponent(ReferenceDrop);
    fixture.componentRef.setInput('mode', mode);
    fixture.componentRef.setInput('slots', slots);
    fixture.detectChanges();
    return fixture;
  }

  it('shows two labelled slots for keyframes', () => {
    const fixture = make('keyframes');
    const labels = Array.from(fixture.nativeElement.querySelectorAll('.ref-slot-label')).map((e) =>
      (e as HTMLElement).textContent!.trim(),
    );
    expect(labels).toEqual(['First frame', 'Last frame']);
  });

  it('shows filled slots plus one empty slot up to the max for ref2v', () => {
    const fixture = make('ref2v', [{ path: 'u/a.png', url: 'blob:a' }]);
    expect(fixture.nativeElement.querySelectorAll('.ref-slot').length).toBe(2);
    expect(fixture.nativeElement.querySelectorAll('.ref-slot-filled').length).toBe(1);
  });

  it('uploads a dropped file and emits the new slot list', async () => {
    api.postForm.mockResolvedValue({ uploadId: 'u/x.png', url: 'https://s/x.png' });
    const fixture = make('i2v');
    const emitted: unknown[] = [];
    fixture.componentInstance.slotsChanged.subscribe((s) => emitted.push(s));
    await fixture.componentInstance.addFile(0, new File([new Uint8Array([1, 2])], 'x.png', { type: 'image/png' }));
    expect(api.postForm).toHaveBeenCalledWith('/uploads', expect.any(FormData));
    expect(emitted[0]).toEqual([{ path: 'u/x.png', url: 'https://s/x.png' }]);
  });

  it('surfaces moderation errors', async () => {
    api.postForm.mockRejectedValue({ error: 'content_policy', message: 'Image blocked.' });
    const fixture = make('i2v');
    await fixture.componentInstance.addFile(0, new File([new Uint8Array([1])], 'x.png', { type: 'image/png' }));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.ref-error').textContent).toContain('Image blocked.');
  });
});

function slot(path: string): RefSlot { return { path, url: 'blob:test' }; }
function makeHost({ mode }: { mode: VideoMode }) {
  TestBed.configureTestingModule({ providers: [{ provide: ApiService, useValue: { postForm: vi.fn() } }] });
  const fixture = TestBed.createComponent(ReferenceDrop);
  let latest: (RefSlot | null)[] = mode === 'keyframes' ? [null, null] : [];
  fixture.componentRef.setInput('mode', mode);
  fixture.componentRef.setInput('slots', latest);
  fixture.componentInstance.slotsChanged.subscribe((slots) => {
    latest = slots;
    fixture.componentRef.setInput('slots', slots);
    fixture.detectChanges();
  });
  fixture.detectChanges();
  const component = fixture.componentInstance;
  return {
    place: (index: number, value: RefSlot) => component.place(index, value),
    clear: (index: number) => component.clear(index),
    complete: () => component.complete(),
    serialize: () => component.serialize(),
    emitted: () => latest,
  };
}

describe('R25: slots keep their meaning', () => {
  it('filling the END frame first leaves the first frame empty', () => {
    const host = makeHost({ mode: 'keyframes' });
    host.place(1, slot('last.png'));
    expect(host.emitted()[0]).toBeNull();
    expect(host.emitted()[1]?.path).toBe('last.png');
  });

  it('clearing the first frame does NOT promote the last frame', () => {
    const host = makeHost({ mode: 'keyframes' });
    host.place(0, slot('first.png'));
    host.place(1, slot('last.png'));
    host.clear(0);
    expect(host.emitted()[0]).toBeNull();
    expect(host.emitted()[1]?.path).toBe('last.png');
  });

  it('replacing the last frame leaves the first alone', () => {
    const host = makeHost({ mode: 'keyframes' });
    host.place(0, slot('first.png'));
    host.place(1, slot('last.png'));
    host.place(1, slot('other.png'));
    expect(host.emitted()[0]?.path).toBe('first.png');
    expect(host.emitted()[1]?.path).toBe('other.png');
  });

  it('two uploads resolving out of order keep their slots', () => {
    const host = makeHost({ mode: 'keyframes' });
    // The second drop finishes uploading first.
    host.place(1, slot('last.png'));
    host.place(0, slot('first.png'));
    expect(host.emitted()[0]?.path).toBe('first.png');
    expect(host.emitted()[1]?.path).toBe('last.png');
  });

  it('keyframes mode with only the last frame filled is INCOMPLETE', () => {
    const host = makeHost({ mode: 'keyframes' });
    host.place(1, slot('last.png'));
    expect(host.complete()).toBe(false);
  });

  it('i2v needs exactly one reference', () => {
    const host = makeHost({ mode: 'i2v' });
    expect(host.complete()).toBe(false);
    host.place(0, slot('a.png'));
    expect(host.complete()).toBe(true);
  });

  it('serialization drops nulls only at the very end', () => {
    // The provider order is positional: refs[0] is the first frame,
    // refs[1] the last. A sparse array must be refused, never compacted.
    const host = makeHost({ mode: 'keyframes' });
    host.place(1, slot('last.png'));
    expect(() => host.serialize()).toThrow(/incomplete/i);
  });
});

/**
 * The count check alone is not enough. ref2v accepts one to three
 * references, so [empty, filled] passes a count test while still being a
 * hole — and serializing it would quietly make reference 2 into reference 1.
 */
describe('R25: a hole is not a shorter list', () => {
  it('ref2v with the FIRST slot empty is incomplete, even though one is filled', () => {
    const host = makeHost({ mode: 'ref2v' });
    host.place(1, slot('second.png'));
    expect(host.complete()).toBe(false);
    expect(() => host.serialize()).toThrow(/incomplete/i);
  });

  it('ref2v with the first slot filled is complete', () => {
    const host = makeHost({ mode: 'ref2v' });
    host.place(0, slot('first.png'));
    expect(host.complete()).toBe(true);
    expect(host.serialize()).toEqual(['first.png']);
  });

  it('clearing a middle reference does not renumber the ones after it', () => {
    const host = makeHost({ mode: 'ref2v' });
    host.place(0, slot('a.png'));
    host.place(1, slot('b.png'));
    host.place(2, slot('c.png'));
    host.clear(1);

    expect(host.emitted()[0]?.path).toBe('a.png');
    expect(host.emitted()[1]).toBeNull();
    expect(host.emitted()[2]?.path).toBe('c.png');
    // And the gap must be refused rather than serialized as ['a','c'].
    expect(host.complete()).toBe(false);
  });
});
