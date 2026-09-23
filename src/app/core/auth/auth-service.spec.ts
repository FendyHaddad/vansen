import { TestBed } from '@angular/core/testing';
import { Session, SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH_CLIENT, AuthService } from './auth-service';
import { SessionLifecycle } from './session-lifecycle';

type Handler = (event: string, session: Session | null) => void;

/**
 * The auth client is injected, not imported: Angular's vitest system refuses
 * `vi.mock` on a relative import, and these tests are about what the service
 * does when the client reports a change from somewhere else entirely — an
 * expiry, a revocation, or another tab signing out.
 */
function fakeAuth(handlers: Handler[]) {
  return {
    getSession: () => Promise.resolve({ data: { session: null } }),
    onAuthStateChange: (cb: Handler) => {
      handlers.push(cb);
      return { data: { subscription: { unsubscribe: () => undefined } } };
    },
    signOut: () => Promise.resolve({ error: null }),
  } as unknown as SupabaseClient['auth'];
}

describe('AuthService session teardown', () => {
  let lifecycle: SessionLifecycle;
  const handlers: Handler[] = [];

  beforeEach(async () => {
    handlers.length = 0;
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: AUTH_CLIENT, useValue: fakeAuth(handlers) }],
    });
    lifecycle = TestBed.inject(SessionLifecycle);
    await TestBed.inject(AuthService).whenReady();
  });

  function emit(userId: string | null) {
    const session = userId
      ? ({ user: { id: userId, email: `${userId}@x.com` } } as Session)
      : null;
    for (const h of handlers) h(userId ? 'SIGNED_IN' : 'SIGNED_OUT', session);
  }

  /** The handler is fire-and-forget; give its promise chain a turn. */
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('R12: a sign-out from another tab tears down the stores', async () => {
    const store = { reset: vi.fn() };
    lifecycle.register('store', store);
    emit('user-1');
    await settle();
    emit(null);
    await settle();
    expect(store.reset).toHaveBeenCalled();
  });

  it('R12: a different user signing in tears down the previous account', async () => {
    const store = { reset: vi.fn() };
    lifecycle.register('store', store);
    emit('user-1');
    await settle();
    emit('user-2');
    await settle();
    // null → A is a real change too: the boot observation already settled as
    // "signed out", so signing in is the first teardown.
    expect(store.reset).toHaveBeenCalledTimes(2);
  });

  it('a token refresh for the same user tears down nothing', async () => {
    const store = { reset: vi.fn() };
    lifecycle.register('store', store);
    emit('user-1');
    await settle();
    emit('user-1');
    await settle();
    expect(store.reset).toHaveBeenCalledTimes(1);
  });

  it('signing out goes through the client, so the teardown is driven by the event', async () => {
    const auth = TestBed.inject(AUTH_CLIENT);
    const spy = vi.spyOn(auth, 'signOut');
    await TestBed.inject(AuthService).signOut();
    expect(spy).toHaveBeenCalled();
  });

  it('R: web sign-out is local scope only, so it never revokes connected assistants', async () => {
    // A global sign-out kills every OAuth grant (see the MCP spike report):
    // Claude or ChatGPT would have to re-run the whole consent flow just
    // because the customer signed out of one browser tab.
    const auth = TestBed.inject(AUTH_CLIENT);
    const spy = vi.spyOn(auth, 'signOut');
    await TestBed.inject(AuthService).signOut();
    expect(spy).toHaveBeenCalledWith({ scope: 'local' });
  });
});

/**
 * Password recovery.
 *
 * Two things matter more than the happy path. First, the response must be
 * identical whether or not the address has an account — otherwise the form is
 * a free account-enumeration oracle, and "no account with that email" is all
 * an attacker needs to build a list of customers. Second, being signed in is
 * NOT permission to set a password: A opening B's recovery link must never be
 * able to change B's password, and a plain session must never satisfy the
 * reset form.
 */
function recoveryAuth(handlers: Handler[], over: Record<string, unknown> = {}) {
  return {
    getSession: () => Promise.resolve({ data: { session: null }, error: null }),
    onAuthStateChange: (cb: Handler) => {
      handlers.push(cb);
      return { data: { subscription: { unsubscribe: () => undefined } } };
    },
    signOut: () => Promise.resolve({ error: null }),
    resetPasswordForEmail: vi.fn(() => Promise.resolve({ data: {}, error: null })),
    resend: vi.fn(() => Promise.resolve({ data: {}, error: null })),
    updateUser: vi.fn(() => Promise.resolve({ data: {}, error: null })),
    exchangeCodeForSession: vi.fn(() =>
      Promise.resolve({ data: { session: null }, error: null }),
    ),
    ...over,
  } as unknown as SupabaseClient['auth'];
}

describe('AuthService password recovery', () => {
  const handlers: Handler[] = [];
  let auth: ReturnType<typeof recoveryAuth>;
  let service: AuthService;

  async function setup(over: Record<string, unknown> = {}) {
    handlers.length = 0;
    TestBed.resetTestingModule();
    auth = recoveryAuth(handlers, over);
    TestBed.configureTestingModule({
      providers: [{ provide: AUTH_CLIENT, useValue: auth }],
    });
    service = TestBed.inject(AuthService);
    await service.whenReady();
  }

  const spy = (name: string) =>
    (auth as unknown as Record<string, ReturnType<typeof vi.fn>>)[name];

  beforeEach(() => setup());

  it('sends the reset link to this origin\'s /reset page', async () => {
    // Never a redirect target taken from a query parameter: that turns our own
    // email into a way to deliver someone else's recovery code to an attacker.
    await service.requestPasswordReset('person@example.com');
    expect(spy('resetPasswordForEmail')).toHaveBeenCalledWith('person@example.com', {
      redirectTo: `${location.origin}/reset`,
    });
  });

  it('answers an unknown address exactly as it answers a known one', async () => {
    await expect(service.requestPasswordReset('nobody@example.com')).resolves.toBeUndefined();
  });

  it('answers the same way when the vendor reports the address does not exist', async () => {
    await setup({
      resetPasswordForEmail: vi.fn(() =>
        Promise.resolve({ data: {}, error: { message: 'User not found', status: 400 } }),
      ),
    });
    await expect(service.requestPasswordReset('nobody@example.com')).resolves.toBeUndefined();
  });

  it('answers the same way when the vendor rate-limits the address', async () => {
    // A different answer here says "this address is worth rate limiting",
    // which is the same disclosure by another route.
    await setup({
      resetPasswordForEmail: vi.fn(() =>
        Promise.resolve({
          data: {},
          error: { message: 'For security purposes, you can only request this after 47 seconds', status: 429 },
        }),
      ),
    });
    await expect(service.requestPasswordReset('person@example.com')).resolves.toBeUndefined();
  });

  it('normalises the address before sending', async () => {
    await service.requestPasswordReset('  Person@Example.COM  ');
    expect(spy('resetPasswordForEmail')).toHaveBeenCalledWith(
      'person@example.com',
      expect.anything(),
    );
  });

  it('resends a confirmation with the signup type and our own redirect', async () => {
    await service.resendConfirmation('person@example.com');
    expect(spy('resend')).toHaveBeenCalledWith({
      type: 'signup',
      email: 'person@example.com',
      options: { emailRedirectTo: `${location.origin}/confirm` },
    });
  });

  it('answers a resend for an unknown address identically', async () => {
    await setup({
      resend: vi.fn(() =>
        Promise.resolve({ data: {}, error: { message: 'User not found', status: 400 } }),
      ),
    });
    await expect(service.resendConfirmation('nobody@example.com')).resolves.toBeUndefined();
  });

  it('never echoes vendor text to the caller', async () => {
    // Even the generic failure must not carry the vendor's wording: it leaks
    // implementation detail and sometimes the address itself.
    await setup({
      resetPasswordForEmail: vi.fn(() => Promise.reject(new Error('fetch failed: ECONNREFUSED 10.0.0.4'))),
    });
    await expect(service.requestPasswordReset('person@example.com')).rejects.toThrow(
      /try again/i,
    );
    await expect(service.requestPasswordReset('person@example.com')).rejects.not.toThrow(
      /ECONNREFUSED/,
    );
  });

  it('refuses a reset with no recovery flow at all', async () => {
    await expect(service.completePasswordReset('a-good-password')).rejects.toThrow(
      /reset link/i,
    );
    expect(spy('updateUser')).not.toHaveBeenCalled();
  });

  it('refuses a reset for an ordinary signed-in session', async () => {
    // Being signed in is not permission to set a password. Without this, any
    // authenticated visitor who navigates to /reset can change their password
    // with no link at all — and worse, the page implies a link was verified.
    await setup({
      getSession: () =>
        Promise.resolve({ data: { session: { user: { id: 'user-a' } } }, error: null }),
    });
    await expect(service.completePasswordReset('a-good-password')).rejects.toThrow(
      /reset link/i,
    );
    expect(spy('updateUser')).not.toHaveBeenCalled();
  });

  it('accepts a reset after a verified recovery for the same identity', async () => {
    await setup({
      getSession: () =>
        Promise.resolve({ data: { session: { user: { id: 'user-b' } } }, error: null }),
    });
    handlers.forEach((h) =>
      h('PASSWORD_RECOVERY', { user: { id: 'user-b' } } as unknown as Session),
    );
    await service.completePasswordReset('a-good-password');
    expect(spy('updateUser')).toHaveBeenCalledWith({ password: 'a-good-password' });
  });

  it('refuses when A is signed in and opens B\'s recovery link', async () => {
    // The recovery event named B; the live session is still A. Updating here
    // would change A's password from a link addressed to B.
    await setup({
      getSession: () =>
        Promise.resolve({ data: { session: { user: { id: 'user-a' } } }, error: null }),
    });
    handlers.forEach((h) =>
      h('PASSWORD_RECOVERY', { user: { id: 'user-b' } } as unknown as Session),
    );
    await expect(service.completePasswordReset('a-good-password')).rejects.toThrow(
      /reset link/i,
    );
    expect(spy('updateUser')).not.toHaveBeenCalled();
  });

  it('refuses an expired recovery', async () => {
    await setup({
      getSession: () =>
        Promise.resolve({ data: { session: { user: { id: 'user-b' } } }, error: null }),
    });
    handlers.forEach((h) =>
      h('PASSWORD_RECOVERY', { user: { id: 'user-b' } } as unknown as Session),
    );
    vi.useFakeTimers({ now: Date.now() + 31 * 60_000, toFake: ['Date'] });
    await expect(service.completePasswordReset('a-good-password')).rejects.toThrow(
      /expired/i,
    );
    vi.useRealTimers();
    expect(spy('updateUser')).not.toHaveBeenCalled();
  });

  it('refuses a second use of the same recovery', async () => {
    // A reused link must never change the password a second time.
    await setup({
      getSession: () =>
        Promise.resolve({ data: { session: { user: { id: 'user-b' } } }, error: null }),
    });
    handlers.forEach((h) =>
      h('PASSWORD_RECOVERY', { user: { id: 'user-b' } } as unknown as Session),
    );
    await service.completePasswordReset('a-good-password');
    await expect(service.completePasswordReset('another-password')).rejects.toThrow(
      /reset link/i,
    );
    expect(spy('updateUser')).toHaveBeenCalledTimes(1);
  });

  it('drops the recovery when the identity changes', async () => {
    await setup({
      getSession: () =>
        Promise.resolve({ data: { session: { user: { id: 'user-b' } } }, error: null }),
    });
    handlers.forEach((h) =>
      h('PASSWORD_RECOVERY', { user: { id: 'user-b' } } as unknown as Session),
    );
    handlers.forEach((h) => h('SIGNED_OUT', null));
    await expect(service.completePasswordReset('a-good-password')).rejects.toThrow(
      /reset link/i,
    );
  });

  it('cancelling the reset drops the recovery', async () => {
    await setup({
      getSession: () =>
        Promise.resolve({ data: { session: { user: { id: 'user-b' } } }, error: null }),
    });
    handlers.forEach((h) =>
      h('PASSWORD_RECOVERY', { user: { id: 'user-b' } } as unknown as Session),
    );
    service.cancelPasswordReset();
    await expect(service.completePasswordReset('a-good-password')).rejects.toThrow(
      /reset link/i,
    );
  });

  it('rejects a short password without contacting the vendor', async () => {
    await setup({
      getSession: () =>
        Promise.resolve({ data: { session: { user: { id: 'user-b' } } }, error: null }),
    });
    handlers.forEach((h) =>
      h('PASSWORD_RECOVERY', { user: { id: 'user-b' } } as unknown as Session),
    );
    await expect(service.completePasswordReset('short')).rejects.toThrow(/8 characters/);
    expect(spy('updateUser')).not.toHaveBeenCalled();
  });

  it('keeps the recovery usable when the update itself fails', async () => {
    // A transient failure must leave the customer able to retry, not send them
    // back to their mailbox for a fresh link.
    await setup({
      getSession: () =>
        Promise.resolve({ data: { session: { user: { id: 'user-b' } } }, error: null }),
      updateUser: vi.fn(() => Promise.resolve({ data: {}, error: { message: 'boom' } })),
    });
    handlers.forEach((h) =>
      h('PASSWORD_RECOVERY', { user: { id: 'user-b' } } as unknown as Session),
    );
    await expect(service.completePasswordReset('a-good-password')).rejects.toThrow();
    expect(service.recoveryPending()).toBe(true);
  });

  it('never stores a recovery code anywhere it could be read back', async () => {
    await setup({
      getSession: () =>
        Promise.resolve({ data: { session: { user: { id: 'user-b' } } }, error: null }),
    });
    handlers.forEach((h) =>
      h('PASSWORD_RECOVERY', { user: { id: 'user-b' } } as unknown as Session),
    );
    const dump = JSON.stringify({ ...localStorage, ...sessionStorage });
    expect(dump).not.toContain('user-b-code');
    // The public signal says only that a recovery is open — never who, and
    // never with what.
    expect(service.recoveryPending()).toBe(true);
  });
});
