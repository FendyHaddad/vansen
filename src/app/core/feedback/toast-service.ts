import { Injectable } from '@angular/core';
import { toast } from '@spartan-ng/brain/sonner';

/** Sonner's options type, which the package does not export by name. */
type ToastOptions = Parameters<typeof toast.success>[1];

export interface ToastAction {
  label: string;
  onClick: () => void;
}

/**
 * One place every component reports the outcome of something the user did.
 * The app-wide <hlm-toaster> in app.html renders these top-right. Components
 * inject this rather than the sonner global so specs can swap it for a spy.
 */
@Injectable({ providedIn: 'root' })
export class ToastService {
  success(message: string, action?: ToastAction): void {
    toast.success(message, withAction(action));
  }

  error(message: string, action?: ToastAction): void {
    toast.error(message, withAction(action));
  }

  info(message: string, action?: ToastAction): void {
    toast.info(message, withAction(action));
  }
}

function withAction(action?: ToastAction): ToastOptions {
  if (!action) return undefined;
  return { action: { label: action.label, onClick: () => action.onClick() } };
}
