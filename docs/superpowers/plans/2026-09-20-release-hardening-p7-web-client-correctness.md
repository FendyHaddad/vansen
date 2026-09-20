# Release Hardening P7 — Web Client Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The web client isolates accounts and edit sessions, preserves unsaved work, provides access to a 500-item library without eagerly fetching originals, and proves the exposed editor tools work within measured resource limits on supported browsers/devices.

**Architecture:** A session epoch replaces ad-hoc teardown: every store registers a reset, the auth layer bumps the epoch on any identity change from any tab, and responses stamped with an old epoch are dropped. The editor gets an explicit lifetime — an open token, a save revision and a dirty-navigation guard — so an async open cannot resurrect a closed session and an unsaved edit cannot vanish silently. The library moves to cursor pagination with real server-side thumbnails. ML models move behind a manifest with a size budget, an integrity hash and a cache eviction policy.

**Tech Stack:** Angular 22 (standalone, signals, zoneless, OnPush), Supabase Auth, Cache Storage, ONNX Runtime Web, Deno Edge Functions.

**Source spec:** `docs/superpowers/plans/2026-09-17-release-readiness-review-and-implementation-plan.md` — this plan implements **T09**, **T10**, **T13** and **T14**, closing **R12**, **R13**, **R16**, **R17** and **R18**. It depends on P1 (gateway test seam) and P5 (`GET /jobs` is read-only). Its thumbnail work is a prerequisite for the mobile plan's library screen.

## Global Constraints

- **Never commit, branch, or push.** Every task ends with "user commits". No `git commit` steps.
- **No nested if statements.** Guard clauses and early returns only.
- **Angular components always use three files** — `.ts` + `.html` + `.css`. Never inline a template or a style. Prefer stylesheet classes over `style` attributes.
- **Standalone, signals, zoneless, `OnPush`.** No `NgModule`, no `zone.js` assumptions, no `setTimeout`-driven change detection.
- **Migration numbering:** P1 `0017`, P2 `0018`, P4 `0019`, P5 `0020`, P6 `0021`. This plan adds `0022`.
- **Never clear a user's unsaved work without asking.** A teardown that discards a dirty editor is data loss, not hygiene.
- **A signed URL is not an identifier.** Cache and compare by generation id; URLs rotate every 7 days.
- **No third-party bytes execute unverified.** Every ML model is fetched against a pinned size and SHA-256.
- **Build:** `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use 22.23.1 >/dev/null && npx ng build`
- **Tests:** Angular → `npm test -- --watch=false` (never bare `npx vitest run`; it falsely fails every TestBed spec). Edge → `cd supabase/functions && deno test --allow-all _shared api job-worker cleanup-worker stripe-webhook appstore-webhook`.
- **Baseline after P6:** vitest 244 plus whatever P6 added; record the exact number before starting.
- **Preserve the established visual composition.** These are behavior and resource fixes, not a redesign.
- **T14 is required before release.** Model download integrity and disk-cache eviction do not replace image/history limits, live-session disposal, preview scheduling or real-weight quality measurements.

## Review Focus

- Image A's queued operation, model result or save completes after image B opens: Task 2 must keep B's pixels, identity, dirty state and busy state unchanged.
- A worker is terminated while operations are queued: Task 2 must settle all old promises and permit new-image operations.
- Crop/rotation or account switching invalidates a selection mask: Task 2 must reject its old dimensions/session before inference.
- Cache Storage is denied, full or corrupt: Tasks 4–5 must preserve network-only editing and actionable retry without retaining corrupt weights.
- A supported boundary-size image exhausts history or inference memory: Tasks 5–6 must enforce measured caps before allocation and demonstrate actual browser behavior.

---

## The defects in one paragraph

`AuthService` (`src/app/core/auth/auth-service.ts`) subscribes to `onAuthStateChange` and does exactly one thing: sets a signal. Every actual teardown — `ledger.reset()`, `store.reset()`, `profileStore.reset()`, `notifications.reset()`, `editSession.close()`, `clearAllCaches()`, `mediaCache.clear()` — lives inside `WorkspacePage.signOut()` (`workspace-page.ts:819-831`). So a token expiry, a session revoked server-side, or a sign-out performed in another tab (which Supabase broadcasts) leaves every store holding the previous account's data, and a second account signing in on the same browser inherits it. `AuthService` has no `reset()` of its own. `EditSession` is a root singleton whose `open()` is async and uncancellable: navigate away mid-decode and `openWithBuffer` still runs, repopulating a session the user closed. Nothing guards navigation while `dirty` is true. `GET /generations` (`api/index.ts:762-771`) returns up to 200 rows with no cursor and signs a URL per row and per thumbnail, and **images have no thumbnails at all** — only videos get a `thumb_path`, from a client-captured poster — so the grid downloads full-resolution originals. And `model-loader.ts` fetches seven models from `huggingface.co` totalling roughly 250 MB with no integrity check, no size budget and no eviction, into a `vansen-models` cache that only grows.

---

## File Structure

**New:**
- `src/app/core/auth/session-lifecycle.ts` + `.spec.ts` — the epoch, the registry, `resettable()`.
- `src/app/core/editing/edit-lifetime.spec.ts` — regression coverage for lifetime tokens and save identity in `EditSession`.
- `src/app/core/editing/editor-policy.ts` + `.spec.ts` — byte/pixel resource policy and pre-allocation guards.
- `src/app/core/media/media-cache.spec.ts` — storage-denied and quota fallback.
- `src/app/core/editing/engines/model-loader.spec.ts` — session disposal, retry and provider fallback.
- `docs/verification/editor-fixtures.json`, `docs/verification/editor-tool-results.md` — licensed/synthetic fixtures and measured runtime evidence.
- `src/app/core/editing/unsaved-changes-guard.ts` + `.spec.ts` — `CanDeactivate`.
- `src/app/core/editing/engines/model-manifest.ts` + `.spec.ts` — pinned sizes, hashes, budget.
- `src/app/core/editing/engines/model-budget.ts` + `.spec.ts` — Cache Storage eviction.
- `supabase/migrations/0022_thumbnails.sql` — `thumb_path` for images, backfill marker.
- `supabase/functions/_shared/thumbnail.ts` + `_test.ts` — server-side downscale.
- `supabase/functions/api/library_pagination_test.ts`.

**Modified:**
- `src/app/core/auth/auth-service.ts`, and every store with a `reset()`.
- `src/app/features/workspace/workspace-page.ts` — `signOut` delegates.
- `src/app/core/editing/edit-session.ts` — lifetime tokens.
- `src/app/core/editing/edit-engine.ts` + `.spec.ts`, `preview-scheduler.ts` + `.spec.ts` — bounded history and latest-only preview execution.
- `src/app/core/editing/engines/bokeh-engine.ts`, `upscale-engine.ts`, `engine-status.ts`, and other engine call sites — proxy previews, output caps and session release.
- `src/app/core/media/media-cache.ts` — network-only fallback and bounded personal media retention.
- `src/app/features/studio/tool-options/tool-options.ts` — mask invalidation and preview scheduling.
- `src/app/core/generations/generation-store.ts` — cursor paging.
- `src/app/core/api/dtos.ts` — `GenerationsResponse.nextCursor`.
- `src/app/core/editing/engines/model-loader.ts` — verification + budget.
- `supabase/functions/api/app.ts` — `GET /generations` cursor, thumbnail generation.
- `src/app/app.routes.ts` — the deactivate guard.

---

## Task 1: Session epoch and central teardown (T09 → R12)

**Files:**
- Create: `src/app/core/auth/session-lifecycle.ts`, `session-lifecycle.spec.ts`
- Modify: `src/app/core/auth/auth-service.ts`, `src/app/core/api/api-service.ts`, `src/app/features/workspace/workspace-page.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface Resettable { reset(): void | Promise<void>; }
  @Injectable({ providedIn: 'root' })
  export class SessionLifecycle {
    readonly epoch: Signal<number>;
    readonly userId: Signal<string | null>;
    register(name: string, target: Resettable): void;
    /** Identity changed: bump the epoch, run every reset, wipe caches. */
    onIdentityChange(nextUserId: string | null): Promise<void>;
    /** True when this epoch is still current — in-flight work checks it. */
    isCurrent(epoch: number): boolean;
  }
  ```

- [ ] **Step 1: Write the failing spec**

Create `src/app/core/auth/session-lifecycle.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi, beforeEach } from 'vitest';
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
    await lifecycle.onIdentityChange('user-1');
    await lifecycle.onIdentityChange('user-2');
    expect(lifecycle.epoch()).toBe(start + 2);
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
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd /Users/user/IdeaProjects/vansen && npm test -- --watch=false src/app/core/auth/session-lifecycle.spec.ts
```

Expected: FAIL — cannot resolve `./session-lifecycle`.

- [ ] **Step 3: Write `session-lifecycle.ts`**

```ts
import { Injectable, signal } from '@angular/core';

/** Anything holding per-account state. Stores register themselves. */
export interface Resettable {
  reset(): void | Promise<void>;
}

/**
 * One place that knows "the person using this browser changed".
 *
 * Teardown used to live inside WorkspacePage.signOut(), so it only ran when
 * someone clicked Sign out on that page. A token expiry, a revoked session, or
 * a sign-out performed in another tab left every store holding the previous
 * account's library, balance and notifications — and the next account to sign
 * in on the same browser inherited them.
 *
 * The epoch is the second half: work started under one identity carries the
 * epoch it began with, and anything that comes back after a change is dropped
 * rather than written into the new account's state.
 */
@Injectable({ providedIn: 'root' })
export class SessionLifecycle {
  private readonly epochSig = signal(0);
  private readonly userSig = signal<string | null>(null);
  private readonly targets = new Map<string, Resettable>();
  private settled = false;

  readonly epoch = this.epochSig.asReadonly();
  readonly userId = this.userSig.asReadonly();

  register(name: string, target: Resettable): void {
    this.targets.set(name, target);
  }

  registeredNames(): string[] {
    return [...this.targets.keys()];
  }

  isCurrent(epoch: number): boolean {
    return epoch === this.epochSig();
  }

  async onIdentityChange(nextUserId: string | null): Promise<void> {
    const previous = this.userSig();
    this.userSig.set(nextUserId);

    // The first observation establishes who we are; it is not a change.
    if (!this.settled) {
      this.settled = true;
      return;
    }
    // A token refresh reports the same user. Wiping the library every hour
    // would make the app blink for no reason.
    if (previous === nextUserId) return;

    this.epochSig.update((n) => n + 1);
    await this.resetAll();
  }

  private async resetAll(): Promise<void> {
    for (const [name, target] of this.targets) {
      try {
        await target.reset();
      } catch (e) {
        // A half-finished teardown is the failure mode this class prevents,
        // so one bad store must not stop the rest.
        console.error('reset_failed', name, e);
      }
    }
  }
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd /Users/user/IdeaProjects/vansen && npm test -- --watch=false src/app/core/auth/session-lifecycle.spec.ts
```

Expected: `8 passed`.

- [ ] **Step 5: Write the failing AuthService spec**

Append to a new `src/app/core/auth/auth-service.spec.ts` (create it; there is none today):

```ts
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AuthService } from './auth-service';
import { SessionLifecycle } from './session-lifecycle';

const handlers: Array<(event: string, session: unknown) => void> = [];

vi.mock('../supabase/supabase-client', () => ({
  supabase: {
    auth: {
      getSession: () => Promise.resolve({ data: { session: null } }),
      onAuthStateChange: (cb: (e: string, s: unknown) => void) => {
        handlers.push(cb);
        return { data: { subscription: { unsubscribe: () => undefined } } };
      },
      signOut: () => Promise.resolve({ error: null }),
    },
  },
}));

describe('AuthService session teardown', () => {
  let lifecycle: SessionLifecycle;

  beforeEach(async () => {
    handlers.length = 0;
    TestBed.configureTestingModule({});
    lifecycle = TestBed.inject(SessionLifecycle);
    await TestBed.inject(AuthService).whenReady();
  });

  function emit(event: string, userId: string | null) {
    const session = userId ? { user: { id: userId, email: `${userId}@x.com` } } : null;
    for (const h of handlers) h(event, session);
  }

  it('R12: a sign-out from another tab tears down the stores', async () => {
    const store = { reset: vi.fn() };
    lifecycle.register('store', store);
    emit('SIGNED_IN', 'user-1');
    await Promise.resolve();
    emit('SIGNED_OUT', null);
    await Promise.resolve();
    expect(store.reset).toHaveBeenCalled();
  });

  it('R12: a different user signing in tears down the previous account', async () => {
    const store = { reset: vi.fn() };
    lifecycle.register('store', store);
    emit('SIGNED_IN', 'user-1');
    await Promise.resolve();
    emit('SIGNED_IN', 'user-2');
    await Promise.resolve();
    expect(store.reset).toHaveBeenCalledTimes(1);
  });

  it('a token refresh for the same user tears down nothing', async () => {
    const store = { reset: vi.fn() };
    lifecycle.register('store', store);
    emit('SIGNED_IN', 'user-1');
    await Promise.resolve();
    emit('TOKEN_REFRESHED', 'user-1');
    await Promise.resolve();
    expect(store.reset).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: Run to verify it fails, then wire `AuthService`**

```bash
cd /Users/user/IdeaProjects/vansen && npm test -- --watch=false src/app/core/auth/auth-service.spec.ts
```

Expected: FAIL — no teardown happens.

In `src/app/core/auth/auth-service.ts`:

```ts
import { Injectable, computed, inject, signal } from '@angular/core';
import { Session } from '@supabase/supabase-js';
import { supabase } from '../supabase/supabase-client';
import { SessionLifecycle } from './session-lifecycle';
```

```ts
  private readonly lifecycle = inject(SessionLifecycle);

  constructor() {
    this.readyPromise = supabase.auth.getSession().then(async ({ data }) => {
      this.sessionSig.set(data.session);
      await this.lifecycle.onIdentityChange(data.session?.user.id ?? null);
    });
    // Every identity change — including an expiry, a server-side revocation,
    // and a sign-out performed in ANOTHER TAB — arrives here. Teardown used to
    // live in one page's click handler, so none of those cases cleaned up.
    supabase.auth.onAuthStateChange((_event, session) => {
      this.sessionSig.set(session);
      void this.lifecycle.onIdentityChange(session?.user.id ?? null);
    });
  }
```

- [ ] **Step 7: Register every store**

Each store gains a constructor registration. `GenerationStore` already has `reset()`; confirm each of these does, and add it where missing:

```bash
cd /Users/user/IdeaProjects/vansen && for f in generations/generation-store ledger/ledger-service profile/profile-store notifications/notification-store personas/persona-store preferences/preferences-service jobs/job-poller media/media-cache editing/edit-session; do printf '%-40s ' "$f"; grep -c "reset()\|clear()\|close()" "src/app/core/$f.ts"; done
```

In each store's constructor:

```ts
  constructor() {
    inject(SessionLifecycle).register('generations', this);
  }
```

`MediaCache` registers with `reset: () => this.clear()`; `EditSession` with `reset: () => this.close()`. Add the localStorage wipe as its own registration in `SessionLifecycle`'s consumer — a small root service or directly in `AuthService`:

```ts
    this.lifecycle.register('local-cache', { reset: () => clearAllCaches() });
```

**`EditSession.close()` discards unsaved pixels.** That is correct on a real identity change — the previous user's work must not persist for the next one — but it must not be silent. Have `EditSession.reset()` record the loss so the UI can say so:

```ts
  /** Identity changed under us. The previous account's pixels cannot stay, but
   * losing work without a word is worse than saying it plainly. */
  reset(): void {
    const lost = this.dirtySig();
    this.close();
    this.discardedOnSignOutSig.set(lost);
  }
```

- [ ] **Step 8: Make `WorkspacePage.signOut` delegate**

```ts
  async signOut(): Promise<void> {
    // Teardown lives in SessionLifecycle now, driven by the auth event, so it
    // also runs for an expiry or a sign-out from another tab.
    await this.auth.signOut();
    this.router.navigate(['/']);
  }
```

Delete the seven teardown calls from that method. They are now duplicated work at best and a source of drift at worst.

- [ ] **Step 9: Drop stale responses in `ApiService`**

```ts
  private async request<T>(method: string, path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    const epoch = this.lifecycle.epoch();
    // ... perform the request ...
    if (!this.lifecycle.isCurrent(epoch)) {
      // Started as one account, came back after another signed in. Writing
      // this into the new account's stores is how one person's library ends
      // up on another person's screen.
      throw new StaleSessionError(path);
    }
    return parsed;
  }
```

Add a spec proving it:

```ts
it('R12: a response that arrives after a user switch is discarded', async () => {
  // resolve the fetch only after the lifecycle epoch has moved
});
```

- [ ] **Step 10: Run the whole suite**

```bash
cd /Users/user/IdeaProjects/vansen && npm test -- --watch=false
```

Expected: all green with the new specs added. User commits.

---

## Task 2: Editor lifetime, save revision and dirty navigation (T10 → R13)

**Files:**
- Create: `src/app/core/editing/edit-lifetime.spec.ts`, `src/app/core/editing/unsaved-changes-guard.ts` + `.spec.ts`
- Modify: `src/app/core/editing/edit-session.ts`, `src/app/app.routes.ts`, the workspace edit-mode component

**Interfaces:**
- Produces:
  ```ts
  // On EditSession:
  readonly openToken: Signal<number>;     // bumped by open() and close()
  readonly revision: Signal<number>;      // bumped by every committed change
  readonly discardedOnSignOut: Signal<boolean>;
  adoptItem(saved: GenerationDto, savedAtRevision: number, savedAtToken: number): 'adopted' | 'stale';
  // Guard:
  export const unsavedChangesGuard: CanDeactivateFn<unknown>;
  ```

- [ ] **Step 1: Write the failing lifetime spec**

Create `src/app/core/editing/edit-lifetime.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, beforeEach } from 'vitest';
import { EditSession } from './edit-session';
import { GenerationDto } from '../api/dtos';

function item(id: string): GenerationDto {
  return {
    id, kind: 'image', familyId: 'flux', familyName: 'FLUX', op: 'generate',
    prompt: 'a cat', settings: {}, priceCredits: 40, status: 'done',
    mediaUrl: 'https://x/1.png', parentId: null, createdAt: '2026-09-20T00:00:00Z',
  } as GenerationDto;
}

function buffer(w = 4, h = 4) {
  return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
}

describe('EditSession lifetime', () => {
  let session: EditSession;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    session = TestBed.inject(EditSession);
  });

  it('closing bumps the open token', () => {
    session.openWithBuffer(item('g1'), buffer());
    const token = session.openToken();
    session.close();
    expect(session.openToken()).not.toBe(token);
  });

  it('R13: a load that finishes after close does not resurrect the session', () => {
    session.openWithBuffer(item('g1'), buffer());
    const token = session.openToken();
    session.close();
    // The async open() captured `token` before awaiting the decode.
    session.completeOpen(token, item('g1'), buffer());
    expect(session.item()).toBeNull();
  });

  it('R13: opening a second image cancels the first load', () => {
    session.openWithBuffer(item('g1'), buffer());
    const stale = session.openToken();
    session.openWithBuffer(item('g2'), buffer());
    session.completeOpen(stale, item('g1'), buffer());
    expect(session.item()?.id).toBe('g2');
  });

  it('every committed change bumps the revision', async () => {
    session.openWithBuffer(item('g1'), buffer());
    const start = session.revision();
    await session.apply('flip', 'h');
    expect(session.revision()).toBeGreaterThan(start);
  });

  it('R13: adopting a save taken at the current revision clears dirty', async () => {
    session.openWithBuffer(item('g1'), buffer());
    await session.apply('flip', 'h');
    const at = session.revision();
    const token = session.openToken();
    expect(session.adoptItem(item('g2'), at, token)).toBe('adopted');
    expect(session.dirty()).toBe(false);
  });

  it('R13: a save that landed before a later edit does NOT clear dirty', async () => {
    // The save request left at revision 3; the user painted again while it was
    // in flight. Marking the session clean here tells them their newest work
    // is saved when it is not, and the next navigation discards it silently.
    session.openWithBuffer(item('g1'), buffer());
    await session.apply('flip', 'h');
    const at = session.revision();
    const token = session.openToken();
    await session.apply('flip', 'v');
    expect(session.adoptItem(item('g2'), at, token)).toBe('stale');
    expect(session.dirty()).toBe(true);
  });

  it('a save adopted into a closed session is ignored', () => {
    session.openWithBuffer(item('g1'), buffer());
    const at = session.revision();
    const token = session.openToken();
    session.close();
    expect(session.adoptItem(item('g2'), at, token)).toBe('stale');
    expect(session.item()).toBeNull();
  });

  it('reset records that unsaved work was discarded', async () => {
    session.openWithBuffer(item('g1'), buffer());
    await session.apply('flip', 'h');
    session.reset();
    expect(session.discardedOnSignOut()).toBe(true);
    expect(session.item()).toBeNull();
  });

  it('reset on a clean session records nothing', () => {
    session.openWithBuffer(item('g1'), buffer());
    session.reset();
    expect(session.discardedOnSignOut()).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails, then implement the lifetime**

```bash
cd /Users/user/IdeaProjects/vansen && npm test -- --watch=false src/app/core/editing/edit-lifetime.spec.ts
```

Expected: FAIL — `openToken`, `revision`, `completeOpen` do not exist.

In `src/app/core/editing/edit-session.ts`:

```ts
  /** Identifies one opening. An async open captures it before awaiting and
   * checks it after; a close or a second open invalidates it.
   *
   * open() decodes an image, which takes hundreds of milliseconds on a large
   * file. Without this, navigating away mid-decode still ran openWithBuffer
   * and repopulated a session the user had already left. */
  private readonly openTokenSig = signal(0);
  /** Bumped by every committed change. A save carries the revision it was
   * taken at, so a save that lands after a later edit cannot claim the
   * session is clean. */
  private readonly revisionSig = signal(0);
  private readonly discardedSig = signal(false);

  readonly openToken = this.openTokenSig.asReadonly();
  readonly revision = this.revisionSig.asReadonly();
  readonly discardedOnSignOut = this.discardedSig.asReadonly();
```

```ts
  private cancelWorkerTask: (() => void) | null = null;

  async open(item: GenerationDto): Promise<void> {
    const token = this.beginOpen();
    this.busySig.set(true);
    let bitmap: ImageBitmap | undefined;
    try {
      bitmap = await createImageBitmap(await this.media.blob(item.id, item.mediaUrl));
      if (token !== this.openTokenSig()) return;
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      const img = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      this.completeOpen(token, item, { width: img.width, height: img.height, data: img.data });
    } finally {
      bitmap?.close();
      if (token === this.openTokenSig()) this.busySig.set(false);
    }
  }

  beginOpen(): number {
    this.close();
    return this.openTokenSig();
  }

  completeOpen(token: number, item: GenerationDto, buf: PixelBuffer): void {
    if (token !== this.openTokenSig()) return;
    this.revisionSig.set(0);
    this.discardedSig.set(false);
    this.engine = new EditEngine(buf);
    this.itemSig.set(item);
    this.dirtySig.set(false);
    this.zoomSig.set(1);
    this.historyTick.update((n) => n + 1);
    this.refreshPreview();
  }

  openWithBuffer(item: GenerationDto, buf: PixelBuffer): void {
    this.completeOpen(this.beginOpen(), item, buf);
  }

  close(): void {
    this.openTokenSig.update((n) => n + 1);
    this.previewToken++;
    this.renderSeq++;
    this.cancelWorkerTask?.();
    this.cancelWorkerTask = null;
    this.worker?.terminate();
    this.worker = null;
    this.opQueue = Promise.resolve();
    this.engine = null;
    this.smallBase = null;
    this.itemSig.set(null);
    this.dirtySig.set(false);
    this.busySig.set(false);
    this.zoomSig.set(1);
    this.pointPickSig.set(null);
    this.previewBufSig.set(null);
    this.historyTick.update((n) => n + 1);
    this.revokePreview();
  }
```

`beginOpen()` invalidates the old operation lifetime through `close()`. `completeOpen()` installs decoded pixels without changing that new token again, so its matching `finally` can release busy state safely. Step 2c wires `cancelWorkerTask`; Step 2d supplies the component mask invalidation. All UI callers must complete the dirty-work decision before beginning a replacement open. Task 5 adds its measured pixel guard before the canvas allocation above and its history policy when constructing `EditEngine`.

```ts
  /** After a save: keep editing the same pixels under the new version's
   * identity — but only if nothing changed while the save was in flight. */
  adoptItem(saved: GenerationDto, savedAtRevision: number, savedAtToken: number): 'adopted' | 'stale' {
    if (!this.itemSig()) return 'stale';
    if (savedAtToken !== this.openTokenSig()) return 'stale';
    if (savedAtRevision !== this.revisionSig()) return 'stale';
    this.itemSig.set(saved);
    this.dirtySig.set(false);
    return 'adopted';
  }
```

```ts
  private afterChange(dirty = true): void {
    // ... existing body ...
    this.dirtySig.set(dirty);
    this.revisionSig.update((n) => n + 1);
  }
```

Update every `adoptItem` call site and the tests above to capture both `session.revision()` and `session.openToken()` **before** the save request leaves. Revision alone is insufficient: two different images both start at revision zero.

```bash
cd /Users/user/IdeaProjects/vansen && grep -rn "adoptItem" src/app --include=*.ts
```

Each becomes:

```ts
    const at = this.session.revision();
    const token = this.session.openToken();
    const saved = await this.store.saveEdit(/* ... */);
    const outcome = this.session.adoptItem(saved, at, token);
    if (outcome === 'stale') this.notifications.push({ kind: 'info', text: 'Saved — you have newer changes still unsaved.' });
```

- [ ] **Step 2a: Retain the original async-operation regression before changing `apply`**

Add to `edit-session.spec.ts` using its existing `make()` helper and `px()` fixture:

```ts
it('does not commit an old operation into a new session', async () => {
  const session = make();
  session.openWithBuffer({ ...item, id: 'a' }, px(10));
  const oldWork = session.apply('flip', 'h');
  session.close();
  session.openWithBuffer({ ...item, id: 'b' }, px(200));
  await expect(oldWork).resolves.toBeUndefined();
  expect(session.item()?.id).toBe('b');
  expect(session.current()?.data[0]).toBe(200);
  expect(session.dirty()).toBe(false);
});

it('closing during apply settles without throwing', async () => {
  const session = make();
  session.openWithBuffer(item, px(10));
  const work = session.apply('flip', 'h');
  session.close();
  await expect(work).resolves.toBeUndefined();
  expect(session.item()).toBeNull();
});

it('an old save cannot adopt a different image at the same revision', () => {
  const session = make();
  session.openWithBuffer({ ...item, id: 'a' }, px(10));
  const revision = session.revision();
  const token = session.openToken();
  session.openWithBuffer({ ...item, id: 'b' }, px(200));
  expect(session.adoptItem({ ...item, id: 'saved-a' }, revision, token)).toBe('stale');
  expect(session.item()?.id).toBe('b');
  expect(session.current()?.data[0]).toBe(200);
});
```

Run `npm test -- --watch=false --include='src/app/core/editing/edit-session.spec.ts'`. Record the actual RED assertion from the first two cases, not just a missing-method failure. After the lifetime scaffolding exists, prove the equal-revision save case fails if its token comparison is removed.

- [ ] **Step 2b: Guard operations, queue entry and result publication**

Capture the engine and token before awaiting; never read a replacement engine to publish an older result:

```ts
async apply(kind: WorkerOp['kind'], params: unknown): Promise<void> {
  const engine = this.engine;
  if (!engine) return;
  const token = this.openTokenSig();
  this.busySig.set(true);
  try {
    const next = await this.run({ kind, buffer: engine.current, params } as WorkerOp);
    if (token !== this.openTokenSig() || engine !== this.engine) return;
    engine.push(next);
    this.afterChange();
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    throw error;
  } finally {
    if (token === this.openTokenSig() && engine === this.engine) this.busySig.set(false);
  }
}

private run(op: WorkerOp): Promise<PixelBuffer> {
  const token = this.openTokenSig();
  const engine = this.engine;
  return this.enqueue(() => {
    if (token !== this.openTokenSig() || engine !== this.engine) {
      return Promise.reject(new DOMException('Edit session closed', 'AbortError'));
    }
    return this.dispatch(op);
  });
}
```

Apply the same token/engine check to async heal, preview, model inference and PNG publication, including their `finally` writes. A stale `open()` must not reset B's busy flag. Close each decoded `ImageBitmap` in `finally`; only the matching token may install decoded pixels. Increment both `previewToken` and `renderSeq` when opening/closing, clear `smallBase` and point/selection state, and prevent an old `bufferToBlob` completion from installing an object URL. Normal cancellation is consumed at the UI operation boundary; real errors remain visible.

- [ ] **Step 2c: Settle terminated-worker promises before resetting the queue**

Extend `dispatch()` with one active cancellation callback (dispatch is serialized). Its single cleanup function removes both message/error listeners and clears the callback on success, error, synchronous `postMessage` failure or cancellation. `close()` invalidates the token first, invokes the callback to reject the active promise with `AbortError`, terminates the worker, and resets `opQueue` to `Promise.resolve()`. Queued tasks retain their old token and reject before posting. `openWithBuffer()` must use this same teardown before replacing the engine. The complete `close()` example above assumes this cancellation callback is wired; `terminate()` alone does not settle a promise.

Use a fake Worker that holds responses until explicitly released. Add tests for these exact interleavings:

| Interleaving | Required assertion |
|---|---|
| A has an active operation and two queued operations; close A | All three public promises settle; no queued A operation posts after close |
| Open B immediately after terminating A, then apply | B completes without waiting for an A reply; B's worker receives only B's pixels |
| Deliver an A message/error after B starts | No B state changes; old listeners were removed |
| A's model/PNG promise resolves after B opens | No old pixels, preview URL, dirty or busy state is published |
| Close while model inference runs | Eventual output is discarded and resources released; no unhandled rejection |

Run those tests RED against the old queue/worker behavior, then GREEN with cancellation cleanup. Also retain the real browser worker check in Task 6; synchronous fallback alone cannot prove worker teardown.

- [ ] **Step 2d: Reject stale masks and protect in-workspace image changes**

In `tool-options.ts`, store the selection mask with its opening token, image revision, width and height. Clear selection/erase masks on close/open and any committed revision that invalidates them. Before selection removal or heal, require a matching token/revision, matching dimensions and `mask.length === width * height`; return a readable request to reselect on mismatch before allocating or invoking a model. Test a non-square crop, a 90-degree rotation, undo/redo, and switching A→B with equal dimensions.

Use `ConfirmService` for same-route image switches and arriving AI results as well as routing. Test that canceling discard retains current pixels and that a completed AI result is added to the library without auto-opening over dirty work. Tab-close warning and route guards alone do not cover these paths.

- [ ] **Step 2e: Verify all lifetime regressions**

Run `npm test -- --watch=false --include='src/app/core/editing/*.spec.ts'` and the affected `tool-options`/workspace component specs. Record RED and GREEN outputs, then exercise image A→B, close-mid-apply, delayed save and delayed AI completion using the real browser worker. User commits.

- [ ] **Step 3: Write the failing guard spec**

Create `src/app/core/editing/unsaved-changes-guard.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EditSession } from './edit-session';
import { unsavedChangesGuard } from './unsaved-changes-guard';
import { ConfirmService } from '../../shared/confirm/confirm-service';

describe('unsavedChangesGuard', () => {
  let session: EditSession;
  let confirm: { ask: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    confirm = { ask: vi.fn().mockResolvedValue(true) };
    TestBed.configureTestingModule({
      providers: [{ provide: ConfirmService, useValue: confirm }],
    });
    session = TestBed.inject(EditSession);
  });

  function run() {
    return TestBed.runInInjectionContext(() => unsavedChangesGuard());
  }

  it('lets a clean session leave without asking', async () => {
    await expect(run()).resolves.toBe(true);
    expect(confirm.ask).not.toHaveBeenCalled();
  });

  it('R13: asks before leaving a dirty session', async () => {
    session.openWithBuffer({ id: 'g1' } as never, { width: 1, height: 1, data: new Uint8ClampedArray(4) });
    await session.apply('flip', 'h');
    await expect(run()).resolves.toBe(true);
    expect(confirm.ask).toHaveBeenCalled();
  });

  it('R13: staying cancels the navigation', async () => {
    confirm.ask.mockResolvedValue(false);
    session.openWithBuffer({ id: 'g1' } as never, { width: 1, height: 1, data: new Uint8ClampedArray(4) });
    await session.apply('flip', 'h');
    await expect(run()).resolves.toBe(false);
  });
});
```

- [ ] **Step 4: Run to verify it fails, then write the guard**

```bash
cd /Users/user/IdeaProjects/vansen && npm test -- --watch=false src/app/core/editing/unsaved-changes-guard.spec.ts
```

Expected: FAIL — module not found.

Create `src/app/core/editing/unsaved-changes-guard.ts`:

```ts
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
```

If `ConfirmService` does not exist, build it as three files (`.ts` + `.html` + `.css`) under `src/app/shared/confirm/` with a signal-driven overlay, `role="alertdialog"`, `aria-modal="true"`, a focus trap and Escape-cancels. P8 needs the same primitive for its dialogs, so build it properly here.

- [ ] **Step 5: Attach the guard and the unload warning**

In `src/app/app.routes.ts`, add `canDeactivate: [unsavedChangesGuard]` to the workspace route. Closing the tab bypasses the router entirely, so add a browser-level warning in the edit-mode component:

```ts
  constructor() {
    // The router guard cannot see a tab close. This is the only hook the
    // browser offers, and it only works when the handler is registered while
    // the page is genuinely dirty.
    effect((onCleanup) => {
      if (!this.session.dirty()) return;
      const warn = (e: BeforeUnloadEvent) => e.preventDefault();
      addEventListener('beforeunload', warn);
      onCleanup(() => removeEventListener('beforeunload', warn));
    });
  }
```

- [ ] **Step 6: Surface the sign-out discard**

Where `discardedOnSignOut()` is true after a teardown, show a dismissible notice: *"You were signed out while editing. Unsaved changes to that image were discarded."* Add it to the workspace template as a stylesheet-classed banner, never an inline style.

- [ ] **Step 7: Run everything**

```bash
cd /Users/user/IdeaProjects/vansen && npm test -- --watch=false
```

Expected: all green. User commits.

---

## Task 3: Real thumbnails and cursor pagination (T13 → R16, R17)

**Files:**
- Create: `supabase/migrations/0022_thumbnails.sql`, `supabase/functions/_shared/thumbnail.ts` + `_test.ts`, `supabase/functions/api/library_pagination_test.ts`
- Modify: `supabase/functions/api/app.ts`, `src/app/core/api/dtos.ts`, `src/app/core/generations/generation-store.ts`, the library grid component

**The two costs being fixed.** `GET /generations` returns up to 200 rows and calls `signStored` once per media path and once per thumbnail — up to 400 sequential signing round-trips in one request. And images have no `thumb_path` at all, so a grid of 200 images downloads 200 full-resolution PNGs, which on a 4 MP output is hundreds of megabytes of egress per library view.

- [ ] **Step 1: Write the failing pagination test**

Create `supabase/functions/api/library_pagination_test.ts`:

```ts
import { assertEquals, assert } from 'jsr:@std/assert';
import { createApp } from './app.ts';
import { FakeDb, TEST_USER, testDeps } from './testing/fakes.ts';

const AUTH = { authorization: 'Bearer test-token' };

function rows(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `g${String(i).padStart(4, '0')}`,
    user_id: TEST_USER,
    kind: 'image',
    family_id: 'flux',
    family_name: 'FLUX',
    op: 'generate',
    prompt: 'a cat',
    settings: {},
    price_credits: 40,
    status: 'done',
    media_path: `u/${i}.png`,
    thumb_path: `u/${i}.thumb.jpg`,
    storage_backend: 'supabase',
    created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
  })).reverse();
}

Deno.test('R16: a page is bounded and carries a cursor', async () => {
  const deps = testDeps();
  const db = deps.admin as unknown as FakeDb;
  db.tables.generations = rows(120);
  const app = createApp(deps);

  const res = await app.request('/api/generations?limit=50', { headers: AUTH });
  const body = await res.json();

  assertEquals(body.items.length, 50);
  assert(typeof body.nextCursor === 'string' && body.nextCursor.length > 0);
});

Deno.test('R16: the cursor walks the library without gaps or repeats', async () => {
  const deps = testDeps();
  const db = deps.admin as unknown as FakeDb;
  db.tables.generations = rows(120);
  const app = createApp(deps);

  const seen: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 10; page += 1) {
    const url = cursor ? `/api/generations?limit=50&cursor=${cursor}` : '/api/generations?limit=50';
    const body = await (await app.request(url, { headers: AUTH })).json();
    seen.push(...body.items.map((i: { id: string }) => i.id));
    cursor = body.nextCursor ?? null;
    if (!cursor) break;
  }

  assertEquals(seen.length, 120);
  assertEquals(new Set(seen).size, 120, 'no id may appear twice');
});

Deno.test('R16: the last page reports no cursor', async () => {
  const deps = testDeps();
  const db = deps.admin as unknown as FakeDb;
  db.tables.generations = rows(10);
  const app = createApp(deps);
  const body = await (await app.request('/api/generations?limit=50', { headers: AUTH })).json();
  assertEquals(body.nextCursor, null);
});

Deno.test('R16: an absurd limit is clamped, not honoured', async () => {
  const deps = testDeps();
  const db = deps.admin as unknown as FakeDb;
  db.tables.generations = rows(500);
  const app = createApp(deps);
  const body = await (await app.request('/api/generations?limit=100000', { headers: AUTH })).json();
  assert(body.items.length <= 100, `returned ${body.items.length}`);
});

Deno.test('R16: a malformed cursor is a 400, not a full-table scan', async () => {
  const deps = testDeps();
  const db = deps.admin as unknown as FakeDb;
  db.tables.generations = rows(10);
  const app = createApp(deps);
  const res = await app.request('/api/generations?cursor=not-a-cursor', { headers: AUTH });
  assertEquals(res.status, 400);
});

Deno.test('R17: a page signs at most one URL per row', async () => {
  let signCalls = 0;
  const deps = testDeps({ countSign: () => { signCalls += 1; } });
  const db = deps.admin as unknown as FakeDb;
  db.tables.generations = rows(50);
  const app = createApp(deps);

  await app.request('/api/generations?limit=50', { headers: AUTH });

  // The grid needs thumbnails. Full media is signed on demand, when an item
  // is actually opened — signing both for every row doubled the round trips.
  assertEquals(signCalls, 50);
});

Deno.test('R17: opening one item signs its full media', async () => {
  const deps = testDeps();
  const db = deps.admin as unknown as FakeDb;
  db.tables.generations = rows(3);
  const app = createApp(deps);
  const body = await (await app.request('/api/generations/g0002', { headers: AUTH })).json();
  assert(typeof body.item.mediaUrl === 'string' && body.item.mediaUrl.length > 0);
});
```

- [ ] **Step 2: Run to verify it fails, then implement the cursor**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all api/library_pagination_test.ts
```

Expected: FAIL — `nextCursor` is undefined and the route ignores `limit`.

Replace `GET /generations` in `app.ts`:

```ts
const MAX_PAGE = 100;
const DEFAULT_PAGE = 50;

/** Keyset cursor: created_at plus id, so rows sharing a timestamp still order
 * deterministically. Offset paging would skip and repeat rows whenever a
 * generation landed between two page fetches. */
function encodeCursor(row: { created_at: string; id: string }): string {
  return btoa(`${row.created_at}|${row.id}`);
}

function decodeCursor(raw: string): { createdAt: string; id: string } | null {
  try {
    const [createdAt, id] = atob(raw).split('|');
    if (!createdAt || !id) return null;
    if (Number.isNaN(Date.parse(createdAt))) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

app.get('/generations', async (c) => {
  const userId = c.get('userId') as string;
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? DEFAULT_PAGE) || DEFAULT_PAGE, 1), MAX_PAGE);
  const rawCursor = c.req.query('cursor');

  let query = admin
    .from('generations')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit + 1);           // one extra row answers "is there more?"

  if (rawCursor) {
    const cursor = decodeCursor(rawCursor);
    if (!cursor) return fail(c, 400, 'invalid_cursor', 'That page marker is not valid.');
    query = query.or(
      `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`,
    );
  }

  const { data, error } = await query;
  if (error) return fail(c, 400, 'query_failed', error.message);

  const rows = data ?? [];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return c.json({
    items: await toGenerationDtos(page, { thumbsOnly: true }),
    nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
  });
});
```

Make `toGenerationDtos` honour `thumbsOnly` — signing the thumbnail and leaving `mediaUrl` empty — and **sign in parallel**, since the old code awaited each signature in sequence:

```ts
  // Sequential signing made a 200-row page 400 round trips deep. These are
  // independent; issue them together.
  return await Promise.all(rows.map((row) => toGenerationDto(row, opts)));
```

Add `GET /generations/:id` returning one fully-signed item for the detail overlay, if it does not already exist.

- [ ] **Step 3: Generate thumbnails for images**

Create `supabase/migrations/0022_thumbnails.sql`:

```sql
-- 0022: thumbnails for images.
--
-- Only videos had a thumb_path (a client-captured poster), so a library grid
-- of 200 images downloaded 200 full-resolution originals — hundreds of MB of
-- egress to render a page of 200×200 tiles.
-- (written 2026-09-20; apply AFTER 0021_durable_deletion.sql)

-- Rows created before this migration have no thumbnail. Rather than a
-- migration-time backfill (which would need to read every object), mark them
-- and let the backfill script work through them.
alter table public.generations
  add column if not exists thumb_state text not null default 'none'
    check (thumb_state in ('none', 'pending', 'ready', 'failed'));

update public.generations
   set thumb_state = case when coalesce(thumb_path, '') = '' then 'pending' else 'ready' end
 where status = 'done';

create index generations_thumb_backfill_idx
  on public.generations (thumb_state) where thumb_state = 'pending';
```

Create `supabase/functions/_shared/thumbnail.ts` producing a 512 px longest-edge JPEG at quality 0.7, and call it from the settle path (P4's `finishJob`) so every new image gets one:

```ts
// A grid tile is 200 px. Serving a 4 MP PNG into it wastes the customer's
// bandwidth and ours, and it is the single biggest egress line we have.
export const THUMB_MAX_EDGE = 512;
export const THUMB_QUALITY = 0.7;
export async function makeThumbnail(bytes: Uint8Array, contentType: string): Promise<Uint8Array>;
```

Write `_shared/thumbnail_test.ts` asserting: the output's longest edge is ≤ 512, aspect ratio is preserved within one pixel, the output is smaller than the input for a large image, an already-small image is passed through unchanged, and a corrupt input throws rather than returning zero bytes.

Add `scripts/backfill-thumbnails.mjs` that walks `thumb_state = 'pending'` in batches, generates and uploads, and sets `ready` or `failed`. It must be resumable and rate-limited, and it must never touch a row it did not read.

- [ ] **Step 4: Page the client store**

In `src/app/core/api/dtos.ts`:

```ts
export interface GenerationsResponse {
  items: GenerationDto[];
  /** Opaque marker for the next page; null on the last page. */
  nextCursor: string | null;
}
```

In `GenerationStore`, add `loadMore()`, a `hasMore` signal, and make `load()` fetch only the first page. Append rather than replace, de-duplicate by id, and keep the localStorage snapshot to the first page only — caching ten thousand rows in `localStorage` will exceed quota and silently disable the whole cache.

```ts
  /** Only the first page is snapshotted. The cache exists to make the grid
   * appear instantly, not to mirror the library; a large write here throws
   * QuotaExceeded and takes every other cached store down with it. */
  private persist(): void {
    void currentUid().then((uid) =>
      writeCache(`generations.${uid}`, this.itemsSig().slice(0, DEFAULT_PAGE)),
    );
  }
```

Add specs: `loadMore` appends without duplicating, a second `loadMore` at the end is a no-op, and a concurrent `load()` during `loadMore()` does not interleave pages.

- [ ] **Step 5: Make the grid use thumbnails and virtualize**

Point the grid's `<img>` at `thumbUrl` with `mediaUrl` as a fallback, add `loading="lazy"` and `decoding="async"`, and give every tile explicit `width`/`height` attributes so the grid does not reflow as images arrive. Add an intersection-observer sentinel that calls `loadMore()`.

Measure before and after with a seeded library:

```bash
cd /Users/user/IdeaProjects/vansen && export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use 22.23.1 >/dev/null && npx ng build --configuration production 2>&1 | tail -20
```

Record in the verification log: bytes transferred for a first library view, time to first tile, and memory after scrolling 1000 items. The point of this task is those three numbers moving.

- [ ] **Step 6: Run both suites**

```bash
cd /Users/user/IdeaProjects/vansen && npm test -- --watch=false && cd supabase/functions && deno test --allow-all _shared api
```

Expected: all green. User commits.

---

## Task 4: ML model manifest, integrity and budget (T14 → R18)

**Files:**
- Create: `src/app/core/editing/engines/model-manifest.ts` + `.spec.ts`, `model-budget.ts` + `.spec.ts`
- Modify: `src/app/core/editing/engines/model-loader.ts`, `heal-engine.ts`, and every file under `engines/` holding a URL

**The exposure.** Seven models are fetched straight from `huggingface.co` at runtime: MI-GAN 28 MB, ISNet fp16 88 MB, NAFNet 87.5 MB, Depth Anything V2 small 27 MB, Swin2SR 8 MB, SlimSAM encoder + decoder 14 MB. Nothing checks what came back. A compromised or swapped upstream file is executed as a model in the customer's browser, the `vansen-models` cache grows without limit on a device that may have 500 MB of quota, and a customer on a metered connection can be handed 88 MB with no warning.

- [ ] **Step 1: Write the failing manifest spec**

Create `src/app/core/editing/engines/model-manifest.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { MODEL_MANIFEST, modelFor, TOTAL_MANIFEST_BYTES } from './model-manifest';

describe('MODEL_MANIFEST', () => {
  it('every model declares a url, a byte size and a sha-256', () => {
    for (const [id, entry] of Object.entries(MODEL_MANIFEST)) {
      expect(entry.url, id).toMatch(/^https:\/\//);
      expect(entry.bytes, id).toBeGreaterThan(0);
      expect(entry.sha256, id).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.license, id).toBeTruthy();
    }
  });

  it('no model comes from a license-banned source', () => {
    // RMBG (bria), the AGPL ISNet mirror, GFPGAN, CodeFormer, MODNet weights
    // and CelebA face-parsing weights are non-commercial or copyleft and must
    // never ship in a paid product.
    const banned = ['briaai', 'rmbg', 'gfpgan', 'codeformer', 'modnet', 'celeba'];
    for (const [id, entry] of Object.entries(MODEL_MANIFEST)) {
      const url = entry.url.toLowerCase();
      for (const needle of banned) {
        expect(url.includes(needle), `${id} uses a banned source: ${needle}`).toBe(false);
      }
    }
  });

  it('declares a warn threshold for large downloads', () => {
    const big = Object.values(MODEL_MANIFEST).filter((m) => m.bytes > 20_000_000);
    expect(big.length).toBeGreaterThan(0);
    for (const entry of big) expect(entry.warnBeforeDownload).toBe(true);
  });

  it('the whole manifest fits a realistic cache budget', () => {
    // Every model cached at once must stay inside what a browser will
    // actually grant, or the newest download silently evicts an older one.
    expect(TOTAL_MANIFEST_BYTES).toBeLessThan(400_000_000);
  });

  it('modelFor throws on an unknown id rather than fetching something', () => {
    expect(() => modelFor('nope' as never)).toThrow();
  });
});
```

- [ ] **Step 2: Collect the real hashes**

Each hash must be measured, not invented. For each URL:

```bash
cd /private/tmp/claude-502/-Users-user-IdeaProjects-vansen/ae60d9aa-cb0e-417e-8ae9-e8ce2870119f/scratchpad && curl -sL -o migan.onnx "https://huggingface.co/andraniksargsyan/migan/resolve/main/migan_pipeline_v2.onnx" && shasum -a 256 migan.onnx && stat -f%z migan.onnx
```

Repeat for all seven URLs listed by:

```bash
cd /Users/user/IdeaProjects/vansen && grep -rn "https://huggingface.co" src/app/core/editing/
```

Record each `id → url, bytes, sha256, license` pair. **Do not write a placeholder hash.** A wrong hash either blocks a working model or, worse, trains whoever maintains this to ignore the check.

- [ ] **Step 3: Write `model-manifest.ts`**

```ts
/**
 * Every ML model the editor can download, pinned.
 *
 * These files come from huggingface.co and run in the customer's browser.
 * Until this manifest existed nothing checked what came back: a swapped or
 * corrupted upstream file was executed as a model, and roughly 250 MB could
 * accumulate in Cache Storage with no ceiling.
 *
 * Sizes and hashes are measured, never guessed. Regenerate with
 * `scripts/verify-models.mjs` when a model is intentionally updated.
 */
export interface ModelEntry {
  url: string;
  bytes: number;
  sha256: string;
  /** Must be commercially usable. MIT and Apache-2.0 only. */
  license: 'MIT' | 'Apache-2.0';
  /** Ask before spending the customer's bandwidth on a large file. */
  warnBeforeDownload: boolean;
}

export type ModelId =
  | 'heal-migan' | 'cutout-isnet' | 'bokeh-depth-anything'
  | 'upscale-swin2sr' | 'select-slimsam-encoder' | 'select-slimsam-decoder'
  | 'deblur-nafnet';

export const MODEL_MANIFEST: Record<ModelId, ModelEntry> = {
  'heal-migan': {
    url: 'https://huggingface.co/andraniksargsyan/migan/resolve/main/migan_pipeline_v2.onnx',
    bytes: 0,        // ← from Step 2
    sha256: '',      // ← from Step 2
    license: 'MIT',
    warnBeforeDownload: true,
  },
  // ... one entry per URL from Step 2 ...
};

export const TOTAL_MANIFEST_BYTES = Object.values(MODEL_MANIFEST)
  .reduce((sum, entry) => sum + entry.bytes, 0);

export function modelFor(id: ModelId): ModelEntry {
  const entry = MODEL_MANIFEST[id];
  if (!entry) throw new Error(`unknown model: ${id}`);
  return entry;
}
```

Guard against the placeholders surviving:

```bash
cd /Users/user/IdeaProjects/vansen && ! grep -n "bytes: 0\|sha256: ''" src/app/core/editing/engines/model-manifest.ts && echo "MANIFEST COMPLETE"
```

Expected: `MANIFEST COMPLETE`.

- [ ] **Step 4: Write the failing loader spec**

Create `src/app/core/editing/engines/model-loader.spec.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { signal } from '@angular/core';
import { loadModelBytes } from './model-loader';

const progress = signal<number | null>(null);

function entry(bytes: Uint8Array, sha256: string) {
  return {
    url: 'https://example.test/model.onnx',
    bytes: bytes.length,
    sha256,
    license: 'MIT' as const,
    warnBeforeDownload: false,
  };
}

async function sha(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

describe('loadModelBytes integrity', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts bytes whose hash matches', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(bytes)) as never;
    const out = await loadModelBytes(entry(bytes, await sha(bytes)), progress);
    expect(out.length).toBe(4);
  });

  it('R18: rejects bytes whose hash does not match', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(bytes)) as never;
    await expect(loadModelBytes(entry(bytes, 'a'.repeat(64)), progress)).rejects.toThrow(/integrity/i);
  });

  it('R18: rejects a response whose size does not match before hashing it', async () => {
    // A 2 GB response should be refused on its Content-Length, not buffered
    // into memory and then hashed.
    const bytes = new Uint8Array([1, 2, 3, 4]);
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(bytes, { headers: { 'Content-Length': '999999999' } }),
    ) as never;
    await expect(loadModelBytes(entry(bytes, await sha(bytes)), progress)).rejects.toThrow(/size/i);
  });

  it('R18: a failed integrity check evicts the cached copy', async () => {
    // Otherwise a poisoned cache entry is served forever without a network
    // request, so the check never runs again.
    const deleted: string[] = [];
    const bytes = new Uint8Array([9, 9, 9, 9]);
    globalThis.caches = {
      open: () => Promise.resolve({
        match: () => Promise.resolve(new Response(bytes)),
        put: () => Promise.resolve(),
        delete: (k: string) => {
          deleted.push(String(k));
          return Promise.resolve(true);
        },
      }),
    } as never;
    await expect(loadModelBytes(entry(bytes, 'b'.repeat(64)), progress)).rejects.toThrow();
    expect(deleted.length).toBe(1);
  });

  it('reports progress and clears it on failure', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline')) as never;
    await expect(loadModelBytes(entry(new Uint8Array(4), 'c'.repeat(64)), progress)).rejects.toThrow();
    expect(progress()).toBeNull();
  });
});
```

- [ ] **Step 5: Run to verify it fails, then harden the loader**

```bash
cd /Users/user/IdeaProjects/vansen && npm test -- --watch=false src/app/core/editing/engines/model-loader.spec.ts
```

Expected: FAIL — `loadModelBytes` takes a URL string and checks nothing.

Change its signature to take a `ModelEntry` and add the checks:

```ts
/** Model bytes from Cache Storage, else network, verified either way.
 *
 * A cached copy is verified too: if a poisoned entry were trusted because it
 * is cached, the integrity check would run exactly once and never again. */
export async function loadModelBytes(
  entry: ModelEntry,
  progress: WritableSignal<number | null>,
): Promise<Uint8Array> {
  const cache = typeof caches === 'undefined' ? null : await caches.open(MODEL_CACHE);
  const hit = await cache?.match(entry.url);
  if (hit) {
    const cached = new Uint8Array(await hit.arrayBuffer());
    const ok = await verify(cached, entry);
    if (ok) return cached;
    await cache?.delete(entry.url);
    throw new Error(`model integrity check failed (cached): ${entry.url}`);
  }

  const res = await fetch(entry.url);
  if (!res.ok || !res.body) throw new Error(`model fetch failed: ${res.status}`);

  const declared = Number(res.headers.get('Content-Length')) || 0;
  // Refuse on the header before buffering, so a wrong or hostile response
  // cannot make us allocate gigabytes.
  if (declared && declared !== entry.bytes) {
    throw new Error(`model size mismatch: expected ${entry.bytes}, got ${declared}`);
  }

  const bytes = await readWithProgress(res, entry.bytes, progress);
  const ok = await verify(bytes, entry);
  if (!ok) throw new Error(`model integrity check failed: ${entry.url}`);

  await reserveBudget(entry.bytes);
  try {
    await cache?.put(entry.url, new Response(bytes.slice()));
  } catch {
    // Quota or private mode — works this session, re-downloads next time.
  }
  return bytes;
}

async function verify(bytes: Uint8Array, entry: ModelEntry): Promise<boolean> {
  if (bytes.length !== entry.bytes) return false;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
  return hex === entry.sha256;
}
```

`readWithProgress` also aborts as soon as the accumulated length exceeds `entry.bytes`, so a chunked response with no `Content-Length` cannot stream forever.

- [ ] **Step 6: Write and implement the cache budget**

Create `model-budget.spec.ts` asserting: the cache stays under the budget, the least recently used model is evicted first, a model in active use is never evicted, and eviction failure degrades to a skipped cache write rather than an error.

Then `model-budget.ts`:

```ts
/** How much of the customer's device we are willing to occupy. Browsers grant
 * far more than this, but a photo editor quietly holding a quarter of a
 * gigabyte of model weights is not a reasonable default. */
export const MODEL_CACHE_BUDGET_BYTES = 250_000_000;

/** Make room for `bytes`, evicting least-recently-used entries first. */
export async function reserveBudget(bytes: number): Promise<void>;
```

Track last-use timestamps in `localStorage` keyed by URL, and never evict a URL whose session is live.

- [ ] **Step 7: Warn before a large download**

Before a `warnBeforeDownload` model is fetched, show a confirm: *"This tool needs an 88 MB one-time download. It is stored on this device and reused."* Use the `ConfirmService` from Task 2. Respect `navigator.connection?.saveData` by defaulting the dialog to cancel.

- [ ] **Step 8: Point every engine at the manifest**

```bash
cd /Users/user/IdeaProjects/vansen && grep -rln "https://huggingface.co" src/app/core/editing/
```

Each file replaces its hardcoded URL with `modelFor('<id>')`. Then prove none is left:

```bash
cd /Users/user/IdeaProjects/vansen && ! grep -rn "https://huggingface.co" src/app/core/editing --include=*.ts | grep -v model-manifest.ts && echo "ALL MODELS MANIFESTED"
```

Expected: `ALL MODELS MANIFESTED`.

- [ ] **Step 9: Run everything and build**

```bash
cd /Users/user/IdeaProjects/vansen && npm test -- --watch=false && export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use 22.23.1 >/dev/null && npx ng build 2>&1 | tail -15
```

Expected: all specs pass, build succeeds. User commits.

---

## Task 5: Bound editor memory, preview work and runtime sessions (T14 → R17/R18)

**Files:** Modify `src/app/core/editing/edit-engine.ts`, `edit-engine.spec.ts`, `preview-scheduler.ts`, `preview-scheduler.spec.ts`, `edit-session.ts`, `engines/bokeh-engine.ts`, `engines/upscale-engine.ts`, `engines/engine-status.ts`, `engines/model-loader.ts`, `src/app/core/media/media-cache.ts`, and `src/app/features/studio/tool-options/tool-options.ts`. Create `editor-policy.ts`, `editor-policy.spec.ts`, `engines/model-loader.spec.ts`, and `src/app/core/media/media-cache.spec.ts`.

**Interfaces:** Add an optional `{ maxHistoryBytes: number }` constructor argument to `EditEngine` and a read-only `historyBytes` getter summing past + future buffer bytes. Add a pure `assertPixelBudget(width, height, scale, policy): void` in `editor-policy.ts`; `policy` contains `maxInputPixels` and `maxOutputPixels`. `PreviewScheduler` keeps its existing public methods and async `run` callback but permits one active invocation plus one replacement request. Model sessions gain a release contract described in Step 5; disk-cache eviction cannot substitute for releasing live ONNX sessions.

- [ ] **Step 1: Write and observe RED for history and pre-allocation bounds**

Add to `edit-engine.spec.ts` using a one-pixel RGBA fixture:

```ts
const pixel = (value: number) => ({
  width: 1, height: 1, data: new Uint8ClampedArray([value, value, value, 255]),
});

it('bounds past and redo history together while retaining current pixels', () => {
  const engine = new EditEngine(pixel(0), { maxHistoryBytes: 8 });
  for (let i = 1; i <= 25; i++) {
    engine.push(pixel(i));
    expect(engine.historyBytes).toBeLessThanOrEqual(8);
  }
  expect(engine.current.data[0]).toBe(25);
  expect(engine.undo()?.data[0]).toBe(24);
  expect(engine.undo()?.data[0]).toBe(23);
  expect(engine.undo()).toBeNull();
  expect(engine.historyBytes).toBeLessThanOrEqual(8);
  expect(engine.redo()?.data[0]).toBe(24);
  expect(engine.redo()?.data[0]).toBe(25);
});
```

Include mixed-size buffers so moving a larger current image into redo cannot exceed the combined budget. Preserve contiguous undo/redo transitions when evicting: discard the farthest reachable entries, keep the active image, and expose when older undo steps are unavailable. Test that a new edit clears redo and its accounted bytes.

In `editor-policy.spec.ts`, test `assertPixelBudget(2, 2, 2, { maxInputPixels: 4, maxOutputPixels: 16 })` succeeds; `(3, 2, 2)` rejects; and an output limit of 15 rejects the first input. Also reject zero, negative, fractional and unsafe-integer dimensions. Use tiny injected budgets in tests; these are not production sizing decisions. Run the focused specs and record RED before implementation.

- [ ] **Step 2: Implement the budget and verify rejection precedes allocation**

Replace count-only history trimming with byte accounting after push/undo/redo/reset. The active image is outside the history budget but inside the total memory measurement in Task 6. Implement the pure guard with readable limit errors:

```ts
export interface PixelPolicy {
  maxInputPixels: number;
  maxOutputPixels: number;
}

export function assertPixelBudget(
  width: number, height: number, scale: number, policy: PixelPolicy,
): void {
  if (![width, height, scale].every((n) => Number.isSafeInteger(n) && n > 0)) {
    throw new Error('Image dimensions must be positive whole numbers.');
  }
  const input = width * height;
  const output = input * scale * scale;
  if (!Number.isSafeInteger(input) || !Number.isSafeInteger(output)) {
    throw new Error('Image dimensions exceed the supported size.');
  }
  if (input > policy.maxInputPixels || output > policy.maxOutputPixels) {
    throw new Error('This image exceeds the supported editing size.');
  }
}
```

Wire the guard before image-canvas allocation where dimensions are available, before an upscale session is acquired, and before the output buffer is allocated. For local 2× upscale, budget `4 * width * height` output pixels and four bytes per RGBA pixel plus tile/tensor overhead. Keep server-side input checks from P1. Test boundary and one-pixel-over cases in the upscale engine with a session-factory spy: rejection calls neither session creation nor inference. Choose production input/output/history limits only after Task 6's lower-memory measurements, and keep UI errors consistent with those limits.

- [ ] **Step 3: Prove the preview queue cannot grow**

Extend `preview-scheduler.spec.ts` with a held first invocation and multiple animation frames:

```ts
it('keeps one active run and one latest replacement', async () => {
  const frames: FrameRequestCallback[] = [];
  let finish!: () => void;
  let value = 1;
  const seen: number[] = [];
  const scheduler = new PreviewScheduler(
    async () => {
      seen.push(value);
      if (seen.length === 1) await new Promise<void>((resolve) => { finish = resolve; });
    },
    (cb) => frames.push(cb),
    () => {},
  );
  scheduler.schedule();
  frames.shift()!(0);
  for (value = 2; value <= 10; value++) {
    scheduler.schedule();
    frames.shift()?.(0);
  }
  expect(seen).toEqual([1]);
  value = 10;
  finish();
  await Promise.resolve();
  await Promise.resolve();
  frames.shift()?.(0);
  expect(seen).toEqual([1, 10]);
});
```

Run RED against the current RAF-only scheduler. Implement explicit active/pending/generation state; pending represents the latest values rather than an array of callbacks. Completion schedules at most one replacement; cancellation clears pending and invalidates stale completion; rejection releases active state. Add cancellation and rejected-run regressions and run GREEN. Ordered committed operations use the separate edit queue and must never be coalesced away.

Route bokeh slider previews through the same policy and a ≤1100 px longest-edge proxy; transform focus coordinates into proxy space. Committed output stays full resolution. Add tests that slider bursts never enqueue repeated full-resolution bokeh runs and that preview/commit use equivalent focus/strength parameters. Compare exported pixels with fixtures before moving measured CPU-heavy preprocess/blur/export work off the UI thread.

- [ ] **Step 4: Prove private-window and quota fallbacks**

In `media-cache.spec.ts`, stub a successful image response and make `caches.open` reject with `SecurityError`; assert `blob()` returns the fetched bytes. Separately make `cache.put` reject with `QuotaExceededError`; assert the same success and only one fetch. Retain a case where network HTTP 403 fails visibly rather than returning an error document as an image. Make equivalent `loadModelBytes` cases use a valid Task 4 manifest/hash, then test corrupt cached bytes are evicted and refetched once. Restore globals after each test.

Observe RED, then make cache open/match/write failures fall back to a verified network response. Preserve account-scoped identities from Task 1; a stale request may not populate another account's cache. Bound media object URLs and disk retention; eviction revokes only unused URLs and cannot break the currently open image. Test expired signed URLs refresh through an owned-item lookup once; forbidden/deleted items remain readable errors rather than infinite retries. Run focused GREEN.

- [ ] **Step 5: Give live ONNX sessions an explicit lifetime**

In `model-loader.ts`, introduce `acquireOrtSession(entry, progress, providers)` returning `{ session, release(): Promise<void> }`. Its key includes immutable model identity and execution providers; reference counting keeps a session alive while an inference uses it. `release()` is idempotent; when the last owner releases, remove the entry and invoke ONNX `session.release()` exactly once. Rejects during creation evict the pending entry so retry can create a fresh session. Update **every** engine call site to acquire inside its operation and release in `finally`, including the separate MI-GAN path if it owns a session outside this loader. Cancellation discards results immediately but waits for in-flight inference before freeing its session. Task 4's budget uses the same active-owner registry.

Write RED tests with a fake ONNX session factory: two concurrent owners create once; first release does not dispose; final release disposes once; double release does nothing; failed initialization can retry; GPU initialization failure and first-inference failure select CPU or produce an actionable unsupported-device state; repeated open/use/close cycles return the live-session count to baseline. The real-weight proof is Task 6. Run GREEN, then the affected engine suite and production build. User commits.

## Task 6: Verify every exposed tool with real fixtures and devices (T14; spec sections 4/6)

**Files:** Create `docs/verification/editor-fixtures.json` and `docs/verification/editor-tool-results.md`; add browser regression fixtures alongside the affected existing `*.spec.ts` files. Runtime results feed P9 Task 6 and are attached to the exact revision.

- [ ] **Step 1: Record fixtures and executable invariants**

Use synthetic or licensed color-chart, checkerboard, non-square landscape, fine-hair portrait, transparent-edge, blurred, flat-color, large and noisy low-light images. Each fixture entry records path, SHA-256, dimensions, alpha, provenance/license and expected mask/output dimensions. Include actual pinned model revision, SHA-256, tensor layout/range, size and license in the model manifest; replace mutable `resolve/main` URLs with immutable revisions. Keep Task 4's measured hash verification.

Retain automated regressions for zero-strength identity, crop/rotate/flip coordinates, unaffected pixels outside heal/clone/retouch masks, selection coordinates after zoom/crop, exact undo/redo, PNG/WebP alpha and explicit JPEG flattening, 2× upscale dimensions, and preview/commit parameter parity. Add a focused RED test before correcting each discovered behavioral defect; preserve the existing visual composition.

- [ ] **Step 2: Run and record the complete matrix**

For every exposed local tool in source-spec section 4, record tool, fixture, browser/version, OS/device/RAM, execution provider, model hash, cold/warm timing, supported memory measurement, outcome, output file and evidence link. Run Chrome, Safari, and a representative lower-memory device, including a private window. An unavailable measurement is marked unavailable with the observation method used; never invent peak-memory or FPS values.

| Scenario | Acceptance and evidence |
|---|---|
| 2 MP and 4K slider drag for 5 s | Latest value wins; ≤1 active + 1 replacement; record warm proxy latency against the preferred 100 ms target |
| Crop/zoom/brush while models initialize | Controls usable; trace repeated >100 ms main-thread tasks and fix measured preprocessing/blur/export stalls |
| 20+ operations and 20 undo attempts | Combined past+redo byte bound holds; eviction is visible; active pixels retained |
| Upscale at accepted cap and one pixel above | Exactly 2× dimensions at cap; rejection before large allocation above cap; record peak working memory |
| Cold download, slow link, cancel and retry | Honest size/progress; cancellation actionable; no corrupt cached model |
| Valid cache while offline; uncached model offline | Cached tools work; first-use tool explains download requirement and can recover |
| GPU absent, init failure, first inference failure | CPU fallback or an explicit actionable unsupported-device state; never silently wrong pixels |
| Hair/alpha, blur, noisy, flat-color and tile-edge fixtures | Inspect actual outputs for alpha, seams, focus, mask bleed and degradation; fake tensors are insufficient |
| Private window and denied/full storage | Image open/edit/save/export succeeds through the network-only path |
| 500 library items with timestamp ties | All records reachable, older-ID and version-chain access work, offscreen originals are not eagerly fetched |
| Real worker A→B, delayed save, close-mid-inference | No cross-image pixels/state, no wedged queue, no discarded dirty work |

Measure output correctness for adjust, all 17 filters, sharpen/smooth, dehaze, portrait smooth, enhance/levels, clone/retouch/liquify, perspective, heal, smart select/erase, cutout, bokeh, local upscale and AI Sharpen. Inspect exported files rather than screenshots alone. Paid AI tools and persona training additionally require P9's separately authorized smoke budget.

- [ ] **Step 3: Tune only measured failures and requalify affected tools**

Select production pixel/history limits from the smallest supported device's evidence and record their rationale. If a supported case exceeds its budget or has incorrect output, keep its gate open, add the regression, make the smallest correction and rerun that fixture/device case. If a tool is deliberately deferred, disable its entry points and remove its sales claims; document the decision rather than silently omitting its row. A missing device or real-model run is blocked evidence, not a pass.

- [ ] **Step 4: Attach evidence to the release record**

Run the focused suites, full Angular suite and production build. Record the revision and actual outputs plus the filled runtime matrix in `editor-tool-results.md`. P7 cannot close R17/R18 with only mocked inference or a passing build. P9 rechecks this evidence against the final release revision and reruns affected cases after later changes. User commits.

## Exit criteria for P7

- [ ] Signing out in one tab tears down every store in the others; no data from the previous account is visible after a user switch.
- [ ] A token refresh does not wipe the library.
- [ ] A response that arrives after an identity change is discarded, never written into the new account's state.
- [ ] Navigating away from a dirty editor asks first; closing the tab warns.
- [ ] An async image open that finishes after close does not resurrect the session.
- [ ] A save that lands after a later edit does not mark the session clean.
- [ ] An old apply/preview/model/save result cannot alter a new image, even at the same revision; terminated workers settle pending promises and the next image can process work.
- [ ] Selection masks are invalidated on session/dimension/revision changes, and same-route image switches or AI arrivals preserve dirty work.
- [ ] Unsaved work discarded by a forced sign-out is reported to the user, not lost silently.
- [ ] The library pages by cursor with no gaps or repeats across 120 items, clamps its limit, and rejects a malformed cursor.
- [ ] A library page signs one URL per row, not two, and issues them in parallel.
- [ ] Images have real server-side thumbnails; the grid's first-view bytes are measured before and after.
- [ ] Every ML model has a measured size and SHA-256; a mismatch refuses the model and evicts the cached copy.
- [ ] No hardcoded HuggingFace URL remains outside the manifest, and no banned-license source appears in it.
- [ ] The model cache stays inside its budget, evicting least-recently-used first.
- [ ] Combined undo/redo bytes, input/output pixels and active preview count obey the measured policy; bokeh previews use the proxy and rejected upscale sizes allocate no huge output.
- [ ] Personal media works when Cache Storage is denied/full, and live ONNX sessions dispose safely after their last inference owner releases them.
- [ ] Every exposed local tool has real-weight/fixture/device evidence from Task 6, including Chrome, Safari, a lower-memory device, offline/private-window behavior and exported output inspection. Unverified cases remain release blockers.

**Known carry-forward:** product copy, accessibility and recoverability are P8; CI, telemetry and rollout are P9. The thumbnail backfill script exists but has not been run against production — P9 schedules it.
