import { ChangeDetectionStrategy, Component, DestroyRef, effect, inject, output } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideImage, lucideRotateCcw, lucideShieldAlert } from '@ng-icons/lucide';
import { AppNotification, NotificationStore } from '../../core/notifications/notification-store';

const DISMISS_MS = 4000;

@Component({
  selector: 'app-notification-toast',
  templateUrl: './notification-toast.html',
  styleUrl: './notification-toast.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgIcon],
  providers: [provideIcons({ lucideImage, lucideRotateCcw, lucideShieldAlert })],
})
export class NotificationToast {
  private readonly store = inject(NotificationStore);

  /** Emits the generation id to open in the detail overlay. */
  readonly open = output<string>();

  readonly toast = this.store.latestToast;

  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // Every new toast restarts the auto-dismiss window.
    effect(() => {
      if (!this.store.latestToast()) return;
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => this.store.clearToast(), DISMISS_MS);
    });
    inject(DestroyRef).onDestroy(() => {
      if (this.timer) clearTimeout(this.timer);
    });
  }

  icon(n: AppNotification): string {
    if (n.kind === 'refund') return 'lucideRotateCcw';
    if (n.kind === 'blocked') return 'lucideShieldAlert';
    return 'lucideImage';
  }

  onClick(): void {
    const t = this.store.latestToast();
    this.store.clearToast();
    if (t?.notification.genId) {
      this.store.markRead(t.notification.id);
      this.open.emit(t.notification.genId);
    }
  }
}
