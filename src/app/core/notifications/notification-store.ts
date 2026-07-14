import { Injectable, computed, signal } from '@angular/core';
import { currentUid, readCache, writeCache } from '../api/local-cache';

export type NotificationKind = 'refund' | 'ready' | 'blocked';

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  title: string;
  detail?: string;
  /** Generation to open when the row/toast is clicked. */
  genId?: string;
  at: string;
  read: boolean;
}

export type NotificationInput = Omit<AppNotification, 'id' | 'at' | 'read'>;

export interface ToastState {
  notification: AppNotification;
  /** How many more notifications landed in the same batch. */
  extra: number;
}

const MAX_ITEMS = 50;

/**
 * Device-local notification history (generation refunds / results / blocks),
 * snapshotted per user through the shared local-cache helpers so sign-out
 * wiping (clearAllCaches) covers it for free.
 */
@Injectable({ providedIn: 'root' })
export class NotificationStore {
  private readonly listSig = signal<AppNotification[]>([]);
  private readonly toastSig = signal<ToastState | null>(null);
  private uid: string | null = null;

  /** Resolves once the per-uid snapshot has been restored. */
  readonly ready: Promise<void>;

  readonly list = this.listSig.asReadonly();
  readonly latestToast = this.toastSig.asReadonly();
  readonly unreadCount = computed(() => this.listSig().filter((n) => !n.read).length);

  constructor() {
    this.ready = this.restore();
  }

  private async restore(): Promise<void> {
    this.uid = await currentUid();
    const cached = readCache<AppNotification[]>(`notifications.${this.uid}`);
    if (cached && this.listSig().length === 0) this.listSig.set(cached);
  }

  add(input: NotificationInput): void {
    this.addMany([input]);
  }

  /** One batch = one toast; every item still lands in the history. */
  addMany(inputs: NotificationInput[]): void {
    if (inputs.length === 0) return;
    const items = inputs.map((input) => ({
      ...input,
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      read: false,
    }));
    this.listSig.update((list) => [...items.slice().reverse(), ...list].slice(0, MAX_ITEMS));
    this.toastSig.set({ notification: items[items.length - 1], extra: items.length - 1 });
    this.persist();
  }

  markRead(id: string): void {
    this.listSig.update((list) => list.map((n) => (n.id === id ? { ...n, read: true } : n)));
    this.persist();
  }

  markAllRead(): void {
    this.listSig.update((list) => list.map((n) => (n.read ? n : { ...n, read: true })));
    this.persist();
  }

  clearToast(): void {
    this.toastSig.set(null);
  }

  reset(): void {
    this.listSig.set([]);
    this.toastSig.set(null);
  }

  private persist(): void {
    void this.ready.then(() => writeCache(`notifications.${this.uid}`, this.listSig()));
  }
}
