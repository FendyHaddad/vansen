import { TestBed } from '@angular/core/testing';
import type { GenerationItem } from '../../../core/generations/generation-store';
import { VideoPickerDialog } from './video-picker-dialog';

function item(id: string, status: string, kind: string, familyId = 'veo'): GenerationItem {
  return {
    id, status, kind, familyId, familyName: familyId, op: 'generate', prompt: `p-${id}`, settings: { aspectRatio: '16:9' },
    priceCredits: 1, mediaUrl: `https://m/${id}.mp4`, thumbUrl: `https://m/${id}.jpg`, parentId: null, createdAt: '2026-09-06T00:00:00Z',
  } as GenerationItem;
}

describe('VideoPickerDialog', () => {
  function make(items: GenerationItem[], familyId = 'veo') {
    const fixture = TestBed.createComponent(VideoPickerDialog);
    fixture.componentRef.setInput('items', items);
    fixture.componentRef.setInput('familyId', familyId);
    fixture.detectChanges();
    return fixture;
  }

  it('lists only finished videos', () => {
    const fixture = make([item('a', 'done', 'video'), item('b', 'pending', 'video'), item('c', 'done', 'image')]);
    expect(fixture.nativeElement.querySelectorAll('.pick-tile').length).toBe(1);
  });

  it('omni edit only offers omni videos', () => {
    const fixture = make([item('a', 'done', 'video', 'veo'), item('b', 'done', 'video', 'omni')], 'omni');
    expect(fixture.nativeElement.querySelectorAll('.pick-tile').length).toBe(1);
  });

  it('emits picked and closed', () => {
    const fixture = make([item('a', 'done', 'video')]);
    const picked: string[] = [];
    let closed = 0;
    fixture.componentInstance.picked.subscribe((i) => picked.push(i.id));
    fixture.componentInstance.closed.subscribe(() => closed++);
    (fixture.nativeElement.querySelector('.pick-tile') as HTMLButtonElement).click();
    (fixture.nativeElement.querySelector('.backdrop') as HTMLElement).click();
    expect(picked).toEqual(['a']);
    expect(closed).toBe(1);
  });
});
