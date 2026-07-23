import { TestBed } from '@angular/core/testing';
import { describe, beforeEach, expect, it } from 'vitest';
import { StylePicker } from './style-picker';
import { STYLE_PRESETS } from '../../../core/catalog/style-presets';

describe('StylePicker', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [StylePicker] });
  });

  it('shows "None" on the trigger when nothing selected', () => {
    const fixture = TestBed.createComponent(StylePicker);
    fixture.componentRef.setInput('selected', null);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('None');
  });

  it('shows the selected style name on the trigger', () => {
    const fixture = TestBed.createComponent(StylePicker);
    fixture.componentRef.setInput('selected', 'oil-painting');
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Oil painting');
  });

  it('groups all 20 presets into 4 categories', () => {
    const fixture = TestBed.createComponent(StylePicker);
    fixture.componentRef.setInput('selected', null);
    fixture.detectChanges();
    const cmp = fixture.componentInstance;
    expect(cmp.groups.length).toBe(4);
    expect(cmp.groups.flatMap((g) => g.presets).length).toBe(STYLE_PRESETS.length);
  });
});
