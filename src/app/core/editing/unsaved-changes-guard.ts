import { inject } from '@angular/core';
import { CanDeactivateFn } from '@angular/router';
import { ConfirmService } from '../../shared/confirm/confirm-service';
import { EditSession } from './edit-session';

/**
 * Leaving the editor with unsaved pixels used to discard them without a word.
 * The work is expensive — sometimes minutes of masking and healing — and
 * nothing warned before it went.
 */
export const unsavedChangesGuard: CanDeactivateFn<unknown> = async () => {
  const session = inject(EditSession);
  if (!session.dirty()) return true;
  return await inject(ConfirmService).ask({
    title: 'Leave without saving?',
    body: 'Your edits to this image have not been saved. Leaving discards them.',
    confirmLabel: 'Discard edits',
    cancelLabel: 'Keep editing',
    destructive: true,
  });
};
