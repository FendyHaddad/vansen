import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { CancelFlowDialog } from './cancel-flow-dialog';

describe('CancelFlowDialog', () => {
  let fixture: ComponentFixture<CancelFlowDialog>;

  function make(periodEnd: string | null = '2026-07-30T00:00:00Z') {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [CancelFlowDialog] });
    fixture = TestBed.createComponent(CancelFlowDialog);
    fixture.componentRef.setInput('planLabel', 'Studio');
    fixture.componentRef.setInput('periodEnd', periodEnd);
    fixture.componentRef.setInput('totalCredits', 1200);
    fixture.detectChanges();
    return fixture.componentInstance;
  }

  beforeEach(() => TestBed.resetTestingModule());

  it('opens on the value step — what cancelling costs comes before the survey', () => {
    const dialog = make();
    expect(dialog.step()).toBe('value');
    expect(fixture.nativeElement.textContent).toContain('1,200');
    expect(fixture.nativeElement.textContent).toContain('Keep my plan');
  });

  it('will not confirm without a reason', () => {
    const dialog = make();
    dialog.step.set('reason');
    let emitted = 0;
    dialog.confirmed.subscribe(() => (emitted += 1));
    dialog.confirm();
    expect(emitted).toBe(0);
  });

  it('emits the picked reason code once', () => {
    const dialog = make();
    dialog.step.set('reason');
    dialog.choose('too_expensive');
    const emitted: string[] = [];
    dialog.confirmed.subscribe((code) => emitted.push(code));
    dialog.confirm();
    expect(emitted).toEqual(['too_expensive']);
  });

  it('cannot be dismissed or re-confirmed while the request is in flight', () => {
    const dialog = make();
    dialog.step.set('reason');
    dialog.choose('technical_issues');
    fixture.componentRef.setInput('busy', true);
    fixture.detectChanges();
    let dismissed = 0;
    let confirmed = 0;
    dialog.dismissed.subscribe(() => (dismissed += 1));
    dialog.confirmed.subscribe(() => (confirmed += 1));
    dialog.close();
    dialog.confirm();
    expect(dismissed).toBe(0);
    expect(confirmed).toBe(0);
  });

  it('done state shows the confirmation, not the survey', () => {
    make();
    fixture.componentRef.setInput('done', true);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain("won't be billed again");
    expect(fixture.nativeElement.textContent).not.toContain('Why are you leaving?');
  });

  it('shows the server rejection inside the dialog', () => {
    const dialog = make();
    dialog.step.set('reason');
    fixture.componentRef.setInput('error', 'Could not cancel your subscription');
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Could not cancel your subscription');
  });
});
