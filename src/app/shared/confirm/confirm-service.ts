import { Injectable, signal } from '@angular/core';

export interface ConfirmRequest {
  title: string;
  body: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Styles the confirm button as the dangerous choice. */
  destructive?: boolean;
  /**
   * Put focus on Cancel instead of Continue — for questions where the
   * expensive answer should take a deliberate move, not a stray Enter.
   */
  defaultCancel?: boolean;
}

interface PendingConfirm extends ConfirmRequest {
  settle(answer: boolean): void;
}

/**
 * One asked-and-answered question at a time.
 *
 * `window.confirm` blocks the whole thread, cannot be styled, and cannot be
 * tested without stubbing a global. This is the same question as a signal the
 * host component renders, so a guard can await an answer and a test can give
 * one.
 */
@Injectable({ providedIn: 'root' })
export class ConfirmService {
  private readonly pendingSig = signal<PendingConfirm | null>(null);

  readonly pending = this.pendingSig.asReadonly();

  ask(request: ConfirmRequest): Promise<boolean> {
    // A second question replaces the first, answered "no": leaving an
    // abandoned promise pending would hang whatever awaited it.
    this.pendingSig()?.settle(false);
    return new Promise<boolean>((resolve) => {
      this.pendingSig.set({
        ...request,
        settle: (answer) => {
          this.pendingSig.set(null);
          resolve(answer);
        },
      });
    });
  }

  answer(value: boolean): void {
    this.pendingSig()?.settle(value);
  }
}
