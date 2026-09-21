import { ChangeDetectionStrategy, Component, ElementRef, effect, inject, viewChild } from '@angular/core';
import { ConfirmService } from './confirm-service';

/**
 * Renders whatever ConfirmService is currently asking. Mounted once, near the
 * root, so any part of the app can ask a question without owning a dialog.
 */
@Component({
  selector: 'app-confirm-dialog',
  templateUrl: './confirm-dialog.html',
  styleUrl: './confirm-dialog.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConfirmDialog {
  private readonly confirm = inject(ConfirmService);
  private readonly confirmButton = viewChild<ElementRef<HTMLButtonElement>>('confirmButton');
  private readonly cancelButton = viewChild<ElementRef<HTMLButtonElement>>('cancelButton');

  readonly pending = this.confirm.pending;

  constructor() {
    // The question is the only thing on screen that matters, so focus goes to
    // it — otherwise a keyboard user has to hunt for the dialog they did not
    // ask to appear.
    effect(() => {
      const request = this.pending();
      if (!request) return;
      // Some questions cost the customer something — bandwidth, money, work.
      // Those start on Cancel so a stray Enter does not spend it.
      const target = request.defaultCancel ? this.cancelButton() : this.confirmButton();
      queueMicrotask(() => target?.nativeElement.focus());
    });
  }

  answer(value: boolean): void {
    this.confirm.answer(value);
  }

  /** Escape cancels — the safe answer is always "do not do the thing". */
  onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    this.answer(false);
  }

  /** Keeps Tab inside the dialog while it is open. */
  onTab(event: KeyboardEvent, atEnd: boolean): void {
    if (event.key !== 'Tab') return;
    if (event.shiftKey === atEnd) return;
    event.preventDefault();
    const target = atEnd ? 'cancel' : 'confirm';
    const el = (event.currentTarget as HTMLElement).parentElement?.querySelector<HTMLElement>(
      `[data-focus="${target}"]`,
    );
    el?.focus();
  }
}
