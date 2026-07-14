import { ChangeDetectionStrategy, Component, inject, output } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideBell, lucideImage, lucideRotateCcw, lucideShieldAlert } from '@ng-icons/lucide';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { AppNotification, NotificationStore } from '../../core/notifications/notification-store';

@Component({
  selector: 'app-notification-bell',
  templateUrl: './notification-bell.html',
  styleUrl: './notification-bell.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgIcon, ...HlmDropdownMenuImports],
  providers: [
    provideIcons({ lucideBell, lucideImage, lucideRotateCcw, lucideShieldAlert }),
  ],
})
export class NotificationBell {
  readonly store = inject(NotificationStore);

  /** Emits the generation id to open in the detail overlay. */
  readonly open = output<string>();

  badge(): string {
    const count = this.store.unreadCount();
    return count > 9 ? '9+' : String(count);
  }

  kindIcon(n: AppNotification): string {
    if (n.kind === 'refund') return 'lucideRotateCcw';
    if (n.kind === 'blocked') return 'lucideShieldAlert';
    return 'lucideImage';
  }

  onRow(n: AppNotification): void {
    this.store.markRead(n.id);
    if (n.genId) this.open.emit(n.genId);
  }

  timeAgo(iso: string): string {
    const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  }
}
