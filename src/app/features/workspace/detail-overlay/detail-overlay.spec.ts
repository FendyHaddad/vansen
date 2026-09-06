import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
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
