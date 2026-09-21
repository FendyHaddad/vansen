import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiService } from '../api/api-service';
import { GenerationStore } from '../generations/generation-store';
import { JobPoller } from '../jobs/job-poller';
import { LedgerService } from '../ledger/ledger-service';
import { MediaCache } from '../media/media-cache';
import { NotificationStore } from '../notifications/notification-store';
import { PersonaStore } from '../personas/persona-store';
import { ProfileStore } from '../profile/profile-store';
import { SessionLifecycle } from './session-lifecycle';

describe('SessionLifecycle', () => {
  let lifecycle: SessionLifecycle;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    lifecycle = TestBed.inject(SessionLifecycle);
  });

  it('resets every registered store when the user changes', async () => {
    const a = { reset: vi.fn() };
    const b = { reset: vi.fn() };
    lifecycle.register('a', a);
    lifecycle.register('b', b);

    await lifecycle.onIdentityChange('user-1');
    await lifecycle.onIdentityChange('user-2');

    expect(a.reset).toHaveBeenCalledTimes(1);
    expect(b.reset).toHaveBeenCalledTimes(1);
  });

  it('resets on sign-out', async () => {
    const store = { reset: vi.fn() };
    lifecycle.register('store', store);
    await lifecycle.onIdentityChange('user-1');
    await lifecycle.onIdentityChange(null);
    expect(store.reset).toHaveBeenCalledTimes(1);
  });

  it('does NOT reset when the same user re-authenticates', async () => {
    // A token refresh fires the same event. Wiping the library on every
    // refresh would make the app blink every hour for no reason.
    const store = { reset: vi.fn() };
    lifecycle.register('store', store);
    await lifecycle.onIdentityChange('user-1');
    await lifecycle.onIdentityChange('user-1');
    expect(store.reset).not.toHaveBeenCalled();
  });

  it('bumps the epoch on every real identity change', async () => {
    const start = lifecycle.epoch();
    // The first observation establishes who we are; it is not a change, and
    // bumping there would make every request issued while auth was still
    // settling look stale.
    await lifecycle.onIdentityChange('user-1');
    expect(lifecycle.epoch()).toBe(start);
    await lifecycle.onIdentityChange('user-2');
    expect(lifecycle.epoch()).toBe(start + 1);
  });

  it('marks an old epoch as stale', async () => {
    await lifecycle.onIdentityChange('user-1');
    const captured = lifecycle.epoch();
    expect(lifecycle.isCurrent(captured)).toBe(true);
    await lifecycle.onIdentityChange('user-2');
    expect(lifecycle.isCurrent(captured)).toBe(false);
  });

  it('one store throwing does not stop the others', async () => {
    // A half-finished teardown would leave one account's data visible to
    // the next — the exact failure this class exists to prevent.
    const bad = { reset: vi.fn(() => { throw new Error('boom'); }) };
    const good = { reset: vi.fn() };
    lifecycle.register('bad', bad);
    lifecycle.register('good', good);
    await lifecycle.onIdentityChange('user-1');
    await lifecycle.onIdentityChange('user-2');
    expect(good.reset).toHaveBeenCalledTimes(1);
  });

  it('awaits async resets before reporting done', async () => {
    let finished = false;
    lifecycle.register('slow', {
      reset: async () => {
        await Promise.resolve();
        finished = true;
      },
    });
    await lifecycle.onIdentityChange('user-1');
    await lifecycle.onIdentityChange('user-2');
    expect(finished).toBe(true);
  });

  it('registering the same name twice replaces rather than duplicates', () => {
    const first = { reset: vi.fn() };
    const second = { reset: vi.fn() };
    lifecycle.register('same', first);
    lifecycle.register('same', second);
    expect(lifecycle.registeredNames()).toEqual(['same']);
  });
});

/**
 * R12 end to end: the timers really stop, and work that was already in the
 * air under the previous account cannot write into the next one.
 */
describe('SessionLifecycle with real stores', () => {
  let resolveJobs: (value: unknown) => void = () => undefined;

  const api = {
    get: vi.fn((path: string) => {
      if (path.startsWith('/jobs')) return new Promise((r) => (resolveJobs = r));
      if (path.startsWith('/personas')) {
        return Promise.resolve({
          items: [{ id: 'p1', name: 'Ada', status: 'training', photoCount: 12 }],
          slots: { used: 1, max: 3 },
        });
      }
      return Promise.resolve({ items: [pendingItem('g1')] });
    }),
    post: vi.fn(),
    postForm: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  };
  const ledger = { setCredits: vi.fn(), reset: vi.fn() };
  const media = { evict: vi.fn(), clear: vi.fn() };
  const profile = { load: vi.fn().mockResolvedValue(undefined), reset: vi.fn() };
  const notifications = { addMany: vi.fn(), reset: vi.fn() };

  function setup() {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: ApiService, useValue: api },
        { provide: LedgerService, useValue: ledger },
        { provide: MediaCache, useValue: media },
        { provide: ProfileStore, useValue: profile },
        { provide: NotificationStore, useValue: notifications },
      ],
    });
    return {
      lifecycle: TestBed.inject(SessionLifecycle),
      poller: TestBed.inject(JobPoller),
      store: TestBed.inject(GenerationStore),
      personas: TestBed.inject(PersonaStore),
    };
  }

  beforeEach(() => {
    localStorage.clear();
    api.get.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => vi.useRealTimers());

  it('cancels the job poller timer when the account changes', async () => {
    const { lifecycle, poller, store } = setup();
    await lifecycle.onIdentityChange('user-1');
    await store.load();
    poller.watch();
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    await lifecycle.onIdentityChange('user-2');

    // Not "it happens to do nothing when it fires" — the previous account's
    // timer is gone. A poll scheduled under one identity has no business
    // running under the next.
    expect(vi.getTimerCount()).toBe(0);
    api.get.mockClear();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.get).not.toHaveBeenCalled();
  });

  it('a job response that lands after the switch does not repopulate the store', async () => {
    const { lifecycle, poller, store } = setup();
    await lifecycle.onIdentityChange('user-1');
    await store.load();
    poller.watch();
    await vi.advanceTimersByTimeAsync(3000); // the tick fires, the request hangs

    await lifecycle.onIdentityChange('user-2');
    resolveJobs({ items: [doneItem('g1')] });
    await vi.advanceTimersByTimeAsync(0);

    // The previous account's library was cleared by the reset, and nothing
    // put it back.
    expect(store.items()).toEqual([]);
  });

  it('stops the persona training timer when the account changes', async () => {
    const { lifecycle, personas } = setup();
    await lifecycle.onIdentityChange('user-1');
    await personas.load();
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    await lifecycle.onIdentityChange('user-2');
    api.get.mockClear();

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.get).not.toHaveBeenCalled();
    expect(personas.items()).toEqual([]);
  });
});

function doneItem(id: string) {
  return { ...(pendingItem(id) as object), status: 'done' } as never;
}

function pendingItem(id: string) {
  return {
    id,
    kind: 'image',
    status: 'pending',
    familyId: 'flux',
    familyName: 'FLUX',
    op: 'generate',
    prompt: 'x',
    settings: {},
    priceCredits: 40,
    mediaUrl: '',
    thumbUrl: null,
    createdAt: '2026-01-01T00:00:00Z',
  } as never;
}
