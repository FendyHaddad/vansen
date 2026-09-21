import {
  AfterViewInit,
  Directive,
  ElementRef,
  HostListener,
  OnDestroy,
  inject,
  input,
  output,
} from '@angular/core';
import { focusFirst, trapTab } from './focus-trap';

let nextId = 0;

/**
 * Makes an element an actual modal dialog: named, announced, keyboard-trapped
 * and focus-restoring.
 *
 * Seven dialogs in this app were hand-rolled divs. Six declared
 * `role="dialog" aria-modal="true"` and stopped there — none trapped Tab or
 * restored focus — and the detail overlay had no role at all. One directive
 * means one place to get it right.
 *
 * Name it by marking the element that already says what this dialog is with
 * `data-dialog-title`, or pass `appDialogLabel` when the heading is an icon.
 */
@Directive({
  selector: '[appDialog]',
  exportAs: 'appDialog',
})
export class DialogDirective implements AfterViewInit, OnDestroy {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** A literal name, for dialogs whose heading is an image or an icon. */
  readonly appDialogLabel = input('');

  readonly dialogClose = output<void>();

  /** Where focus was before this opened. Restored on destroy. */
  private readonly opener = document.activeElement as HTMLElement | null;

  constructor() {
    const el = this.host.nativeElement;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
  }

  /**
   * After the view, not in the constructor: the element that names the dialog
   * does not exist in the DOM until its content has rendered.
   */
  ngAfterViewInit(): void {
    const el = this.host.nativeElement;
    const label = this.appDialogLabel();
    if (label) el.setAttribute('aria-label', label);
    if (!label) this.labelByContent(el);
    focusFirst(el);
  }

  ngOnDestroy(): void {
    // Skip a detached opener: focusing one does nothing and leaves the caret
    // at the top of the document, which is the bug this exists to prevent.
    if (!this.opener?.isConnected) return;
    this.opener.focus();
  }

  @HostListener('keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      this.dialogClose.emit();
      return;
    }
    if (trapTab(this.host.nativeElement, event)) event.preventDefault();
  }

  private labelByContent(el: HTMLElement): void {
    // A name the template already supplies wins — it was written for this
    // dialog, and replacing it would be a regression dressed as a migration.
    if (el.hasAttribute('aria-labelledby') || el.hasAttribute('aria-label')) return;
    const titled = el.querySelector<HTMLElement>('[data-dialog-title]');
    if (!titled) return;
    titled.id ||= `dialog-title-${nextId++}`;
    el.setAttribute('aria-labelledby', titled.id);
  }
}
