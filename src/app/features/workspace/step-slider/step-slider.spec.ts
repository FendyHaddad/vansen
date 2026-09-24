import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { StepSlider } from './step-slider';
import { FamilyOption } from '../../../core/catalog/model-families';

const OPTIONS: FamilyOption[] = ['1K', '2K', '4K'].map((v) => ({ value: v, label: v, tooltip: v }));

function make(disabled: string[] = [], selected = '1K'): {
  fixture: ComponentFixture<StepSlider>;
  emitted: string[];
} {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [StepSlider] });
  const fixture = TestBed.createComponent(StepSlider);
  fixture.componentRef.setInput('label', 'Resolution');
  fixture.componentRef.setInput('options', OPTIONS);
  fixture.componentRef.setInput('disabled', disabled);
  fixture.componentRef.setInput('selected', selected);
  const emitted: string[] = [];
  fixture.componentInstance.changed.subscribe((v) => emitted.push(v));
  fixture.detectChanges();
  return { fixture, emitted };
}

function slide(fixture: ComponentFixture<StepSlider>, to: number): void {
  const input = fixture.nativeElement.querySelector('.ss-input') as HTMLInputElement;
  input.value = String(to);
  input.dispatchEvent(new Event('input'));
}

describe('StepSlider', () => {
  it('renders one tick and one stop label per option', () => {
    const { fixture } = make();
    expect(fixture.nativeElement.querySelectorAll('.ss-tick').length).toBe(3);
    const labels = Array.from(fixture.nativeElement.querySelectorAll('.ss-stop')) as HTMLElement[];
    expect(labels.map((el) => el.textContent?.trim())).toEqual(['1K', '2K', '4K']);
  });

  it('emits the value of the stop the thumb lands on', () => {
    const { fixture, emitted } = make();
    slide(fixture, 2);
    expect(emitted).toEqual(['4K']);
  });

  it('skips a disabled stop in the direction of travel', () => {
    const { fixture, emitted } = make(['2K']);
    slide(fixture, 1);
    expect(emitted).toEqual(['4K']);
  });

  it('falls back when every stop ahead is disabled', () => {
    const { fixture, emitted } = make(['4K'], '2K');
    slide(fixture, 2);
    expect(emitted).toEqual([]);
    expect((fixture.nativeElement.querySelector('.ss-input') as HTMLInputElement).value).toBe('1');
  });

  it('ignores clicks on a disabled stop label', () => {
    const { fixture, emitted } = make(['4K']);
    (fixture.nativeElement.querySelectorAll('.ss-stop')[2] as HTMLButtonElement).click();
    expect(emitted).toEqual([]);
  });

  it('renders nothing without options', () => {
    const { fixture } = make();
    fixture.componentRef.setInput('options', null);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.ss')).toBeNull();
  });
});

describe('StepSlider thumb motion', () => {
  it('records a move when the selection changes, alternating the animation phase', () => {
    const { fixture } = make();
    const slider = fixture.componentInstance;
    expect(slider.move()).toBeNull();

    fixture.componentRef.setInput('selected', '4K');
    fixture.detectChanges();
    expect(slider.move()).toEqual({ from: 0, to: 2, key: 1 });
    expect(slider.phase()).toBe('a');
    expect(slider.trailStart()).toBe(0);
    expect(slider.trailWidth()).toBe(100);

    fixture.componentRef.setInput('selected', '2K');
    fixture.detectChanges();
    expect(slider.move()).toEqual({ from: 2, to: 1, key: 2 });
    expect(slider.phase()).toBe('b');
    expect(slider.trailStart()).toBe(50);
    expect(slider.trailWidth()).toBe(50);
  });

  it('treats a new option list as a fresh slider, not a move', () => {
    const { fixture } = make();
    fixture.componentRef.setInput('options', [...OPTIONS]);
    fixture.componentRef.setInput('selected', '4K');
    fixture.detectChanges();
    expect(fixture.componentInstance.move()).toBeNull();
  });
});
