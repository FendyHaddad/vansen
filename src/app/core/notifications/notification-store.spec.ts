import { beforeEach, describe, expect, it } from 'vitest';
import { AppNotification } from './notification-store';
import { NotificationStore } from './notification-store';

// No auth session in the test env → currentUid() resolves 'anon'.
const CACHE_KEY = 'vansen.cache.notifications.anon';

function seedCache(items: AppNotification[]): void {
  localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), value: items }));
}

describe('NotificationStore', () => {
  beforeEach(() => localStorage.clear());

  it('add prepends newest first and marks unread', () => {
    const store = new NotificationStore();
    store.add({ kind: 'ready', title: 'Image ready', genId: 'g1' });
    store.add({ kind: 'refund', title: 'Refunded $0.10', genId: 'g2' });
    expect(store.list().map((n) => n.title)).toEqual(['Refunded $0.10', 'Image ready']);
    expect(store.unreadCount()).toBe(2);
  });

  it('caps the history at 50', () => {
    const store = new NotificationStore();
    for (let i = 0; i < 55; i++) store.add({ kind: 'ready', title: `n${i}` });
    expect(store.list().length).toBe(50);
    expect(store.list()[0].title).toBe('n54');
  });

  it('markRead / markAllRead flip flags and unreadCount', () => {
    const store = new NotificationStore();
    store.add({ kind: 'ready', title: 'a' });
    store.add({ kind: 'ready', title: 'b' });
    store.markRead(store.list()[0].id);
    expect(store.unreadCount()).toBe(1);
    store.markAllRead();
    expect(store.unreadCount()).toBe(0);
  });

  it('addMany batches into one toast with extra count', () => {
    const store = new NotificationStore();
    store.addMany([
      { kind: 'ready', title: 'first' },
      { kind: 'refund', title: 'second' },
    ]);
    expect(store.latestToast()?.notification.title).toBe('second');
    expect(store.latestToast()?.extra).toBe(1);
    store.clearToast();
    expect(store.latestToast()).toBeNull();
  });

  it('persists per-uid and restores from cache', async () => {
    seedCache([
      { id: 'x', kind: 'ready', title: 'old', at: '2026-07-13T00:00:00Z', read: true },
    ]);
    const store = new NotificationStore();
    await store.ready;
    expect(store.list().map((n) => n.id)).toEqual(['x']);

    store.add({ kind: 'refund', title: 'new' });
    await store.ready;
    await Promise.resolve();
    const env = JSON.parse(localStorage.getItem(CACHE_KEY)!) as {
      value: AppNotification[];
    };
    expect(env.value.map((n) => n.title)).toEqual(['new', 'old']);
  });

  it('reset clears list and toast', () => {
    const store = new NotificationStore();
    store.add({ kind: 'ready', title: 'a' });
    store.reset();
    expect(store.list()).toEqual([]);
    expect(store.latestToast()).toBeNull();
  });
});
