import { Injector, runInInjectionContext } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationStore } from '../../core/notifications/notification-store';
import { ToastService } from '../../core/feedback/toast-service';
import { toastNotifications } from './notification-toasts';

describe('toastNotifications', () => {
  const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
  let store: NotificationStore;
  let open: ReturnType<typeof vi.fn<(genId: string) => void>>;

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({ providers: [{ provide: ToastService, useValue: toast }] });
    store = TestBed.inject(NotificationStore);
    open = vi.fn<(genId: string) => void>();
    runInInjectionContext(TestBed.inject(Injector), () => toastNotifications(open));
  });

  it('toasts a ready result with a View action that opens the generation', () => {
    store.add({ kind: 'ready', title: 'Image ready', genId: 'gen-1' });
    TestBed.tick();

    expect(toast.success).toHaveBeenCalledTimes(1);
    const [message, action] = toast.success.mock.calls[0];
    expect(message).toBe('Image ready');
    expect(action.label).toBe('View');
    action.onClick();
    expect(open).toHaveBeenCalledWith('gen-1');
    expect(store.list()[0].read).toBe(true);
    expect(store.latestToast()).toBeNull();
  });

  it('counts the rest of a batch and routes blocks to an error toast', () => {
    store.addMany([
      { kind: 'blocked', title: 'first' },
      { kind: 'blocked', title: 'Blocked by moderation' },
    ]);
    TestBed.tick();

    expect(toast.error).toHaveBeenCalledWith('Blocked by moderation (+1 more)', undefined);
  });

  it('shows refunds as info', () => {
    store.add({ kind: 'refund', title: 'Refunded 10 credits', genId: 'gen-2' });
    TestBed.tick();

    expect(toast.info).toHaveBeenCalledWith('Refunded 10 credits', expect.objectContaining({ label: 'View' }));
  });
});
