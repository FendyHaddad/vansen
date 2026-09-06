import { TestBed } from '@angular/core/testing';
import { familyById } from '../../../../core/catalog/model-families';
import { ModePicker } from './mode-picker';

describe('ModePicker', () => {
  function make(familyId: string, selected = 't2v') {
    const fixture = TestBed.createComponent(ModePicker);
    fixture.componentRef.setInput('family', familyById(familyId)!);
    fixture.componentRef.setInput('selected', selected);
    fixture.detectChanges();
    return fixture;
  }

  it('renders only the modes the family supports, in canonical order', () => {
    const fixture = make('runway');
    const labels = Array.from(fixture.nativeElement.querySelectorAll('button.mode-chip')).map((b) =>
      (b as HTMLElement).textContent!.trim(),
    );
    expect(labels).toEqual(['Text → Video', 'Image → Video']);
  });

  it('marks the selected chip and emits on click', () => {
    const fixture = make('omni', 'i2v');
    const emitted: string[] = [];
    fixture.componentInstance.changed.subscribe((m) => emitted.push(m));
    const chips = fixture.nativeElement.querySelectorAll('button.mode-chip') as NodeListOf<HTMLButtonElement>;
    expect(chips[1].classList.contains('mode-chip-on')).toBe(true);
    chips[5].click();
    expect(emitted).toEqual(['edit']);
  });
});
