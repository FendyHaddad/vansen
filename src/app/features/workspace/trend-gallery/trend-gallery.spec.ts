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

/**
 * R26: a missing thumbnail degrades to a named tile.
 *
 * All twelve presets bind `/trends/<id>.webp` and `public/trends/` does not
 * exist, so every tile rendered as a broken-image icon. A unit test could not
 * see it — the DOM is identical whether the file resolves or not — which is
 * why `scripts/check-assets.mjs` exists as well.
 */
describe('TrendGallery missing thumbnails', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [TrendGallery] });
  });

  it('shows nothing as missing until an image actually fails', () => {
    const fixture = TestBed.createComponent(TrendGallery);
    fixture.detectChanges();
    expect(fixture.componentInstance.missing().size).toBe(0);
  });

  it('remembers each thumbnail that failed to load', () => {
    const fixture = TestBed.createComponent(TrendGallery);
    const component = fixture.componentInstance;
    component.markMissing('astronaut');
    component.markMissing('renaissance');
    expect([...component.missing()].sort()).toEqual(['astronaut', 'renaissance']);
  });

  it('does not count the same failure twice', () => {
    const component = TestBed.createComponent(TrendGallery).componentInstance;
    component.markMissing('astronaut');
    component.markMissing('astronaut');
    expect(component.missing().size).toBe(1);
  });

  it('keeps the preset pickable when its thumbnail is gone', () => {
    // The point of the fallback: a name a customer can still click, not a
    // broken tile that looks like the app is failing.
    const component = TestBed.createComponent(TrendGallery).componentInstance;
    const picked: string[] = [];
    component.picked.subscribe((t) => picked.push(t.id));
    component.markMissing(component.trends[0].id);
    component.pick(component.trends[0]);
    expect(picked).toEqual([component.trends[0].id]);
  });
});
