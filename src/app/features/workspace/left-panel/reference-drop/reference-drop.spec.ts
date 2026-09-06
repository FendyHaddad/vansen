import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { ApiService } from '../../../../core/api/api-service';
import { ReferenceDrop } from './reference-drop';

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
