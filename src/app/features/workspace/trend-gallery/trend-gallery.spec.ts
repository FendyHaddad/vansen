import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TrendGallery } from './trend-gallery';
import { TREND_PRESETS } from '../../../core/catalog/trend-presets';

describe('TrendGallery', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [TrendGallery] });
  });

  it('exposes all 12 trends', () => {
    const fixture = TestBed.createComponent(TrendGallery);
    fixture.detectChanges();
    expect(fixture.componentInstance.trends.length).toBe(TREND_PRESETS.length);
  });

  it('emits the preset on pick', () => {
    const fixture = TestBed.createComponent(TrendGallery);
    fixture.detectChanges();
    const picked = vi.fn();
    fixture.componentInstance.picked.subscribe(picked);
    fixture.componentInstance.pick(TREND_PRESETS[0]);
    expect(picked).toHaveBeenCalledWith(TREND_PRESETS[0]);
  });
});
