import { TestBed } from '@angular/core/testing';
import { RenderingChip } from './rendering-chip';

describe('RenderingChip', () => {
  function make(count: number) {
    const fixture = TestBed.createComponent(RenderingChip);
    fixture.componentRef.setInput('count', count);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('renders nothing at zero', () => {
    expect(make(0).querySelector('.rchip')).toBeNull();
  });

  it('pluralises', () => {
    expect(make(1).textContent).toContain('Rendering 1 video');
    expect(make(3).textContent).toContain('Rendering 3 videos');
  });
});
