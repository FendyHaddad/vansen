import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';
import { TermsPage } from './terms-page';
import { PrivacyPage } from './privacy-page';
import { AcceptableUsePage } from './acceptable-use-page';

function render(cmpType: any): HTMLElement {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(cmpType);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('legal pages', () => {
  it('terms page renders title, entity, and core clauses', () => {
    const el = render(TermsPage);
    expect(el.querySelector('h1')?.textContent).toContain('Terms of Service');
    expect(el.textContent).toContain('Vankode Technology');
    expect(el.textContent).toContain('support@vankode.com');
    expect(el.textContent).toContain('Limitation of liability');
    expect(el.textContent).toContain('Governing law');
  });

  it('privacy page renders title and rights sections', () => {
    const el = render(PrivacyPage);
    expect(el.querySelector('h1')?.textContent).toContain('Privacy Policy');
    expect(el.textContent).toContain('GDPR');
    expect(el.textContent).toContain('PDPA');
    expect(el.textContent).toContain('support@vankode.com');
    expect(el.textContent).toContain('We do not sell');
  });

  it('acceptable use page renders title and enforcement', () => {
    const el = render(AcceptableUsePage);
    expect(el.querySelector('h1')?.textContent).toContain('Acceptable Use Policy');
    expect(el.textContent).toContain('zero tolerance');
    expect(el.textContent).toContain('two strikes');
    expect(el.textContent).toContain('support@vankode.com');
  });
});
