import { effect, inject, untracked } from '@angular/core';
import { NotificationStore, type ToastState } from '../../core/notifications/notification-store';
import { ToastService, type ToastAction } from '../../core/feedback/toast-service';

/**
 * Hands each new generation notification (ready / refund / blocked) to the
 * app-wide toaster, with a "View" action that opens the generation. Call from
 * an injection context; `open` receives the generation id.
 */
export function toastNotifications(open: (genId: string) => void): void {
  const store = inject(NotificationStore);
  const toast = inject(ToastService);

  effect(() => {
    const state = store.latestToast();
    if (!state) return;
    untracked(() => {
      store.clearToast();
      show(toast, state, viewAction(store, state, open));
    });
  });
}

function viewAction(
  store: NotificationStore,
  state: ToastState,
  open: (genId: string) => void,
): ToastAction | undefined {
  const { id, genId } = state.notification;
  if (!genId) return undefined;
  return {
    label: 'View',
    onClick: () => {
      store.markRead(id);
      open(genId);
    },
  };
}

function show(toast: ToastService, state: ToastState, action?: ToastAction): void {
  const { kind, title } = state.notification;
  const message = state.extra > 0 ? `${title} (+${state.extra} more)` : title;
  if (kind === 'blocked') {
    toast.error(message, action);
    return;
  }
  if (kind === 'ready') {
    toast.success(message, action);
    return;
  }
  toast.info(message, action);
}
