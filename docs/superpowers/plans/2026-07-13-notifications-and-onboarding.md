# Notifications Center + Onboarding Tour Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Top-bar notification bell (refund / ready / blocked generation events with toast + history) and a Photoshop-style spotlight onboarding tour, per `docs/superpowers/specs/2026-07-13-notifications-and-onboarding-design.md`.

**Architecture:** Client-only. A root `NotificationStore` (signals + localStorage snapshot per uid) is fed by a status diff inside `GenerationStore.applyJobUpdates` and by the moderation error branch in `WorkspacePage`. A root `TourService` (steps + active/index signals, persists `tourSeen` via `PreferencesService`) drives a `TourOverlay` component that spotlights `[data-tour]` targets with a box-shadow cutout.

**Tech Stack:** Angular 22 standalone components, signals, spartan-ng `HlmDropdownMenuImports`, `@ng-icons/lucide`, vitest + TestBed.

## Global Constraints

- **NEVER run `git commit`, `git branch`, or `git push`. The user makes all commits personally.** Skip every commit step you'd normally add — verification ends at green tests/build.
- Angular components use **separate** `.ts` + `.html` + `.css` files. Never inline templates or styles.
- Stylesheet classes over inline `style` attributes. The tour overlay's computed spotlight/card geometry bound via `[style]` is the ONE allowed exception.
- No backend / DB / Edge Function change of any kind.
- Client never does money math — refund title uses server-assigned `priceUsd`; balance re-read from server via `ProfileStore.load()`.
- Build: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use 22.23.1 >/dev/null && npx ng build`
- Tests: same nvm preamble then `npm test`. **Never** bare `npx vitest run` — it falsely fails TestBed specs.
- Theme: use existing CSS variables (`--card`, `--border`, `--foreground`, `--muted-foreground`, `--primary`, `--font-app-mono`) and `color-mix(in oklch, …)` like `workspace-page.css` does.

---

### Task 1: NotificationStore

**Files:**
- Create: `src/app/core/notifications/notification-store.ts`
- Test: `src/app/core/notifications/notification-store.spec.ts`

**Interfaces:**
- Consumes: `currentUid()`, `readCache()`, `writeCache()` from `src/app/core/api/local-cache.ts`.
- Produces (later tasks rely on these exact names):
  - `type NotificationKind = 'refund' | 'ready' | 'blocked'`
  - `interface AppNotification { id: string; kind: NotificationKind; title: string; detail?: string; genId?: string; at: string; read: boolean }`
  - `type NotificationInput = Omit<AppNotification, 'id' | 'at' | 'read'>`
  - `interface ToastState { notification: AppNotification; extra: number }`
  - `class NotificationStore` with `list: Signal<AppNotification[]>` (newest first, cap 50), `unreadCount: Signal<number>`, `latestToast: Signal<ToastState | null>`, `ready: Promise<void>`, `add(input: NotificationInput): void`, `addMany(inputs: NotificationInput[]): void`, `markRead(id: string): void`, `markAllRead(): void`, `clearToast(): void`, `reset(): void`.

- [ ] **Step 1: Write the failing test**

`src/app/core/notifications/notification-store.spec.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/local-cache', () => ({
  currentUid: vi.fn().mockResolvedValue('u1'),
  readCache: vi.fn().mockReturnValue(null),
  writeCache: vi.fn(),
}));

import { readCache, writeCache } from '../api/local-cache';
import { NotificationStore } from './notification-store';

describe('NotificationStore', () => {
  beforeEach(() => {
    vi.mocked(readCache).mockReturnValue(null);
    vi.mocked(writeCache).mockClear();
  });

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
    vi.mocked(readCache).mockReturnValue([
      { id: 'x', kind: 'ready', title: 'old', at: '2026-07-13T00:00:00Z', read: true },
    ]);
    const store = new NotificationStore();
    await store.ready;
    expect(store.list().map((n) => n.id)).toEqual(['x']);

    store.add({ kind: 'refund', title: 'new' });
    await store.ready;
    await Promise.resolve();
    expect(vi.mocked(writeCache)).toHaveBeenCalledWith('notifications.u1', expect.any(Array));
  });

  it('reset clears list and toast', () => {
    const store = new NotificationStore();
    store.add({ kind: 'ready', title: 'a' });
    store.reset();
    expect(store.list()).toEqual([]);
    expect(store.latestToast()).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use 22.23.1 >/dev/null && npm test 2>&1 | tail -15`
Expected: FAIL — cannot resolve `./notification-store`.

- [ ] **Step 3: Implement the store**

`src/app/core/notifications/notification-store.ts`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use 22.23.1 >/dev/null && npm test 2>&1 | tail -8`
Expected: PASS, no other suite broken. **Do NOT commit — the user commits personally.**

---

### Task 2: Status diff in GenerationStore

**Files:**
- Modify: `src/app/core/generations/generation-store.ts` (imports, injects, `applyJobUpdates` at ~line 119)
- Test: `src/app/core/generations/generation-store.spec.ts` (create)

**Interfaces:**
- Consumes: `NotificationStore.addMany(inputs: NotificationInput[])` from Task 1; `ProfileStore.load(): Promise<void>` (existing — re-reads `/profile` and pushes `balanceUsd` into `LedgerService`).
- Produces: `applyJobUpdates` now emits notifications on `pending→done` / `pending→failed` and refreshes balance after a refund. Signature unchanged.

- [ ] **Step 1: Write the failing test**

`src/app/core/generations/generation-store.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/local-cache', () => ({
  currentUid: vi.fn().mockResolvedValue('u1'),
  readCache: vi.fn().mockReturnValue(null),
  writeCache: vi.fn(),
}));

import { ApiService } from '../api/api-service';
import { LedgerService } from '../ledger/ledger-service';
import { MediaCache } from '../media/media-cache';
import { ProfileStore } from '../profile/profile-store';
import { NotificationStore } from '../notifications/notification-store';
import { GenerationDto } from '../api/dtos';
import { GenerationStore } from './generation-store';

function gen(id: string, status: GenerationDto['status'], priceUsd = 0.1): GenerationDto {
  return {
    id,
    kind: 'image',
    familyId: 'flux',
    familyName: 'FLUX',
    op: 'generate',
    prompt: 'p',
    settings: {},
    priceUsd,
    status,
    mediaUrl: '',
    parentId: null,
    createdAt: '2026-07-13T00:00:00Z',
  } as GenerationDto;
}

describe('GenerationStore.applyJobUpdates notifications', () => {
  const apiMock = { get: vi.fn(), post: vi.fn(), postForm: vi.fn(), delete: vi.fn() };
  const ledgerMock = { setBalance: vi.fn() };
  const mediaMock = { evict: vi.fn() };
  const profileMock = { load: vi.fn().mockResolvedValue(undefined) };
  const notifMock = { addMany: vi.fn() };

  async function makeWith(items: GenerationDto[]): Promise<GenerationStore> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: ApiService, useValue: apiMock },
        { provide: LedgerService, useValue: ledgerMock },
        { provide: MediaCache, useValue: mediaMock },
        { provide: ProfileStore, useValue: profileMock },
        { provide: NotificationStore, useValue: notifMock },
      ],
    });
    apiMock.get.mockResolvedValue({ items });
    const store = TestBed.inject(GenerationStore);
    await store.load();
    return store;
  }

  beforeEach(() => {
    apiMock.get.mockReset();
    profileMock.load.mockClear();
    notifMock.addMany.mockReset();
  });

  it('pending→done emits one ready notification', async () => {
    const store = await makeWith([gen('a', 'pending')]);
    store.applyJobUpdates([gen('a', 'done')]);
    expect(notifMock.addMany).toHaveBeenCalledTimes(1);
    const events = notifMock.addMany.mock.calls[0][0];
    expect(events).toEqual([
      expect.objectContaining({ kind: 'ready', genId: 'a', title: 'Image ready' }),
    ]);
    expect(profileMock.load).not.toHaveBeenCalled();
  });

  it('pending→failed emits a refund with priceUsd and refreshes the balance', async () => {
    const store = await makeWith([gen('a', 'pending', 0.1)]);
    store.applyJobUpdates([gen('a', 'failed', 0.1)]);
    const events = notifMock.addMany.mock.calls[0][0];
    expect(events[0]).toEqual(
      expect.objectContaining({ kind: 'refund', genId: 'a', title: 'Refunded $0.10' }),
    );
    expect(profileMock.load).toHaveBeenCalledTimes(1);
  });

  it('a repeat poll of an already-terminal item emits nothing', async () => {
    const store = await makeWith([gen('a', 'pending')]);
    store.applyJobUpdates([gen('a', 'done')]);
    notifMock.addMany.mockClear();
    store.applyJobUpdates([gen('a', 'done')]);
    expect(notifMock.addMany).not.toHaveBeenCalled();
  });

  it('unknown ids and still-pending updates emit nothing', async () => {
    const store = await makeWith([gen('a', 'pending')]);
    store.applyJobUpdates([gen('a', 'pending'), gen('zz', 'done')]);
    expect(notifMock.addMany).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use 22.23.1 >/dev/null && npm test 2>&1 | tail -15`
Expected: FAIL — `addMany` never called (current `applyJobUpdates` only merges).

- [ ] **Step 3: Wire the diff into GenerationStore**

In `src/app/core/generations/generation-store.ts`:

Add imports (after the `MediaCache` import):

```ts
import { NotificationInput, NotificationStore } from '../notifications/notification-store';
import { ProfileStore } from '../profile/profile-store';
```

Add injects (after `private readonly media = inject(MediaCache);`):

```ts
  private readonly notifications = inject(NotificationStore);
  private readonly profile = inject(ProfileStore);
```

Replace the whole `applyJobUpdates` method:

```ts
  /** Merge poll results (status flips, media urls) into the store. */
  applyJobUpdates(updates: GenerationDto[]): void {
    if (updates.length === 0) return;
    const previous = new Map(this.itemsSig().map((i) => [i.id, i]));
    const events: NotificationInput[] = [];
    let refunded = false;
    for (const update of updates) {
      // Only a pending→terminal flip is news; terminal items never change again.
      if (previous.get(update.id)?.status !== 'pending') continue;
      if (update.status === 'done') {
        events.push({
          kind: 'ready',
          title: update.kind === 'video' ? 'Video ready' : 'Image ready',
          detail: `${update.familyName} · ${update.op}`,
          genId: update.id,
        });
      } else if (update.status === 'failed') {
        refunded = true;
        events.push({
          kind: 'refund',
          title: `Refunded $${update.priceUsd.toFixed(2)}`,
          detail: `${update.familyName} · ${update.op} failed — credits returned`,
          genId: update.id,
        });
      }
    }
    const byId = new Map(updates.map((u) => [u.id, u]));
    this.itemsSig.update((list) => list.map((i) => byId.get(i.id) ?? i));
    if (events.length > 0) this.notifications.addMany(events);
    // The server already refunded (fn_fail_job); re-read the authoritative balance.
    if (refunded) void this.profile.load();
    void this.persist();
  }
```

(No import cycle: `ProfileStore` does not import `GenerationStore`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use 22.23.1 >/dev/null && npm test 2>&1 | tail -8`
Expected: PASS, all suites green. **Do NOT commit.**

---

### Task 3: `tourSeen` preference

**Files:**
- Modify: `src/app/core/preferences/preferences-service.ts:4-19`
- Test: `src/app/core/preferences/preferences-service.spec.ts` (create)

**Interfaces:**
- Produces: `Prefs.tourSeen: boolean` (default `false`); later tasks call `prefsService.prefs().tourSeen` and `prefs.update({ tourSeen: true })`.

- [ ] **Step 1: Write the failing test**

`src/app/core/preferences/preferences-service.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiService } from '../api/api-service';
import { PreferencesService } from './preferences-service';

describe('PreferencesService tourSeen', () => {
  const apiMock = { put: vi.fn().mockResolvedValue(undefined) };

  function make(): PreferencesService {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: ApiService, useValue: apiMock }],
    });
    return TestBed.inject(PreferencesService);
  }

  beforeEach(() => {
    localStorage.clear();
    apiMock.put.mockClear();
  });

  it('defaults tourSeen to false', () => {
    expect(make().prefs().tourSeen).toBe(false);
  });

  it('server prefs merge preserves tourSeen', () => {
    const svc = make();
    svc.applyServerPrefs({ tourSeen: true });
    expect(svc.prefs().tourSeen).toBe(true);
  });

  it('update({tourSeen:true}) persists via PUT /prefs', async () => {
    const svc = make();
    await svc.update({ tourSeen: true });
    expect(apiMock.put).toHaveBeenCalledWith(
      '/prefs',
      expect.objectContaining({ tourSeen: true }),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use 22.23.1 >/dev/null && npm test 2>&1 | tail -15`
Expected: FAIL — `tourSeen` missing from `Prefs` (TS error) / default undefined.

- [ ] **Step 3: Add the field**

In `src/app/core/preferences/preferences-service.ts`, add to the `Prefs` interface after `confirmOverUsd: number;`:

```ts
  /** True once the onboarding tour was finished or skipped. */
  tourSeen: boolean;
```

and to `DEFAULTS` after `confirmOverUsd: 2,`:

```ts
  tourSeen: false,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use 22.23.1 >/dev/null && npm test 2>&1 | tail -8`
Expected: PASS. **Do NOT commit.**

---

### Task 4: Notification bell component

**Files:**
- Create: `src/app/shared/notification-bell/notification-bell.ts`
- Create: `src/app/shared/notification-bell/notification-bell.html`
- Create: `src/app/shared/notification-bell/notification-bell.css`

**Interfaces:**
- Consumes: `NotificationStore` (Task 1); spartan dropdown pattern copied from `src/app/shared/profile-menu/profile-menu.html`.
- Produces: `<app-notification-bell (open)="…" />` — `open: OutputEmitterRef<string>` emits a generation id. Task 6 binds it.

- [ ] **Step 1: Component class**

`src/app/shared/notification-bell/notification-bell.ts`:

```ts
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
```

- [ ] **Step 2: Template**

`src/app/shared/notification-bell/notification-bell.html`:

```html
<button
  type="button"
  class="bell-btn"
  [hlmDropdownMenuTrigger]="menu"
  align="end"
  aria-label="Notifications"
>
  <ng-icon name="lucideBell" size="16" />
  @if (store.unreadCount() > 0) {
    <span class="bell-badge">{{ badge() }}</span>
  }
</button>

<ng-template #menu>
  <div hlmDropdownMenu class="notif-dropdown">
    <div class="notif-head">
      <span class="notif-head-title">Notifications</span>
      @if (store.unreadCount() > 0) {
        <button type="button" class="notif-mark-all" (click)="store.markAllRead()">
          Mark all read
        </button>
      }
    </div>
    <hlm-dropdown-menu-separator />
    <div class="notif-list">
      @for (n of store.list(); track n.id) {
        <button
          type="button"
          class="notif-row"
          [class.notif-unread]="!n.read"
          (click)="onRow(n)"
        >
          <ng-icon
            [name]="kindIcon(n)"
            size="15"
            class="notif-icon"
            [class.notif-icon-blocked]="n.kind === 'blocked'"
          />
          <span class="notif-text">
            <span class="notif-title">{{ n.title }}</span>
            @if (n.detail) {
              <span class="notif-detail">{{ n.detail }}</span>
            }
            <span class="notif-time">{{ timeAgo(n.at) }}</span>
          </span>
        </button>
      } @empty {
        <p class="notif-empty">Nothing yet.</p>
      }
    </div>
  </div>
</ng-template>
```

- [ ] **Step 3: Stylesheet**

`src/app/shared/notification-bell/notification-bell.css`:

```css
.bell-btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 1px solid color-mix(in oklch, var(--border) 70%, transparent);
  border-radius: 8px;
  background: transparent;
  color: var(--muted-foreground);
  cursor: pointer;
  transition:
    color 0.12s ease,
    border-color 0.12s ease,
    background-color 0.12s ease;
}

.bell-btn:hover {
  color: var(--foreground);
  border-color: var(--border);
  background: color-mix(in oklch, var(--muted) 45%, transparent);
}

.bell-badge {
  position: absolute;
  top: -5px;
  right: -5px;
  min-width: 15px;
  height: 15px;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--destructive);
  color: #fff;
  font-family: var(--font-app-mono);
  font-size: 9.5px;
  font-weight: 600;
  line-height: 15px;
  text-align: center;
}

.notif-dropdown {
  width: 320px;
  padding: 0;
}

.notif-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px 8px;
}

.notif-head-title {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted-foreground);
}

.notif-mark-all {
  border: 0;
  background: transparent;
  color: var(--muted-foreground);
  font-size: 11.5px;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 5px;
}

.notif-mark-all:hover {
  color: var(--foreground);
  background: color-mix(in oklch, var(--muted) 55%, transparent);
}

.notif-list {
  max-height: 340px;
  overflow-y: auto;
  padding: 4px;
}

.notif-row {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  width: 100%;
  padding: 8px 9px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.notif-row:hover {
  background: color-mix(in oklch, var(--muted) 55%, transparent);
}

.notif-icon {
  flex: 0 0 auto;
  margin-top: 2px;
  color: var(--muted-foreground);
}

.notif-unread .notif-icon {
  color: var(--primary);
}

.notif-icon-blocked,
.notif-unread .notif-icon-blocked {
  color: var(--destructive);
}

.notif-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.notif-title {
  font-size: 12.5px;
  color: var(--muted-foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.notif-unread .notif-title {
  font-weight: 600;
  color: var(--foreground);
}

.notif-detail {
  font-size: 11.5px;
  color: var(--muted-foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.notif-time {
  font-family: var(--font-app-mono);
  font-size: 10px;
  color: color-mix(in oklch, var(--muted-foreground) 75%, transparent);
}

.notif-empty {
  margin: 0;
  padding: 26px 12px;
  text-align: center;
  font-size: 12.5px;
  color: var(--muted-foreground);
}
```

- [ ] **Step 4: Verify it compiles**

Run: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use 22.23.1 >/dev/null && npx ng build 2>&1 | tail -6`
Expected: build succeeds (component not yet referenced — tree-shaken, but type-checked). **Do NOT commit.**

---

### Task 5: Notification toast component

**Files:**
- Create: `src/app/shared/notification-toast/notification-toast.ts`
- Create: `src/app/shared/notification-toast/notification-toast.html`
- Create: `src/app/shared/notification-toast/notification-toast.css`

**Interfaces:**
- Consumes: `NotificationStore.latestToast()` / `clearToast()` / `markRead()` (Task 1).
- Produces: `<app-notification-toast (open)="…" />` — `open: OutputEmitterRef<string>` emits a generation id. Task 6 binds it.

- [ ] **Step 1: Component class**

`src/app/shared/notification-toast/notification-toast.ts`:

```ts
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
```

- [ ] **Step 2: Template**

`src/app/shared/notification-toast/notification-toast.html`:

```html
@if (toast(); as t) {
  <button type="button" class="toast" (click)="onClick()">
    <ng-icon [name]="icon(t.notification)" size="15" class="toast-icon" />
    <span class="toast-title">{{ t.notification.title }}</span>
    @if (t.extra > 0) {
      <span class="toast-extra">(+{{ t.extra }} more)</span>
    }
  </button>
}
```

- [ ] **Step 3: Stylesheet**

`src/app/shared/notification-toast/notification-toast.css`:

```css
.toast {
  position: fixed;
  top: 14px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 60;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: min(420px, calc(100vw - 32px));
  padding: 9px 14px;
  border: 1px solid color-mix(in oklch, var(--border) 80%, transparent);
  border-radius: 10px;
  background: color-mix(in oklch, var(--card) 92%, var(--background));
  color: var(--foreground);
  font-size: 12.5px;
  box-shadow: 0 8px 28px rgb(0 0 0 / 0.18);
  cursor: pointer;
  animation: toast-in 0.22s ease;
}

.toast-icon {
  color: var(--primary);
  flex: 0 0 auto;
}

.toast-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.toast-extra {
  color: var(--muted-foreground);
  font-size: 11.5px;
  white-space: nowrap;
}

@keyframes toast-in {
  from {
    opacity: 0;
    transform: translateX(-50%) translateY(-8px);
  }
  to {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .toast {
    animation: none;
  }
}
```

- [ ] **Step 4: Verify it compiles**

Run: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use 22.23.1 >/dev/null && npx ng build 2>&1 | tail -6`
Expected: build succeeds. **Do NOT commit.**

---

### Task 6: Workspace notification integration

**Files:**
- Modify: `src/app/features/workspace/workspace-page.ts` (imports ~35-40, `imports:` array ~53-62, injects ~76-86, `showError` `content_policy` branch ~212-217, `signOut` ~537-547)
- Modify: `src/app/features/workspace/workspace-page.html` (`.topbar-right` ~46-65, end of `.shell`)

**Interfaces:**
- Consumes: `NotificationBell` (Task 4), `NotificationToast` (Task 5), `NotificationStore` (Task 1), existing `onOpened(id)` / `openedId` detail-overlay wiring.
- Produces: bell + toast live in the workspace; moderation block adds a `blocked` notification; sign-out resets the store.

- [ ] **Step 1: Wire the component class**

In `src/app/features/workspace/workspace-page.ts`:

Add imports (next to the `ProfileMenu` import):

```ts
import { NotificationBell } from '../../shared/notification-bell/notification-bell';
import { NotificationToast } from '../../shared/notification-toast/notification-toast';
import { NotificationStore } from '../../core/notifications/notification-store';
```

Add `NotificationBell, NotificationToast,` to the component `imports:` array (after `ProfileMenu,`).

Add inject (after `private readonly mediaCache = inject(MediaCache);`):

```ts
  private readonly notifications = inject(NotificationStore);
```

In `showError`, extend the `content_policy` branch — keep the existing `notice.set(...)` and add the notification before `return;`:

```ts
      if (e.code === 'content_policy') {
        this.notice.set(
          'This request violates our content policy and was blocked. Two violations suspend your account. If this was a mistake, contact support to appeal.',
        );
        this.notifications.add({
          kind: 'blocked',
          title: 'Blocked by moderation',
          detail: 'The request violated the content policy — nothing was charged.',
        });
        return;
      }
```

In `signOut()`, after `this.profileStore.reset();` add:

```ts
    this.notifications.reset();
```

- [ ] **Step 2: Wire the template**

In `src/app/features/workspace/workspace-page.html`, inside `<div class="topbar-right">`, add the bell **before** the upload label:

```html
      <div class="topbar-right">
        <app-notification-bell data-tour="bell" (open)="onOpened($event)" />
        @if (mode() === 'library' && studioActive()) {
```

At the end of the shell, right before the closing `</div>` of `.shell` (after the `@if (openedItem(); as opened) { … }` block), add:

```html
  <app-notification-toast (open)="onOpened($event)" />
```

- [ ] **Step 3: Build + full tests**

Run: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use 22.23.1 >/dev/null && npm test 2>&1 | tail -5 && npx ng build 2>&1 | tail -6`
Expected: tests PASS, build succeeds. **Do NOT commit.**

---

### Task 7: TourService

**Files:**
- Create: `src/app/core/tour/tour-service.ts`
- Test: `src/app/core/tour/tour-service.spec.ts`

**Interfaces:**
- Consumes: `PreferencesService.update(patch: Partial<Prefs>)` (Task 3 added `tourSeen`).
- Produces (Task 8/9 rely on these exact names):
  - `interface TourStep { id: 'welcome' | 'left-panel' | 'library' | 'right-panel' | 'credits' | 'bell'; target: string | null; title: string; body: string; placement: 'right' | 'left' | 'top' | 'bottom' | 'center' }`
  - `class TourService` with `steps: TourStep[]`, `activeIndex: WritableSignal<number>`, `active: WritableSignal<boolean>`, `current: Signal<TourStep>`, `start()`, `next()`, `prev()`, `skip()`, `finish()`.

- [ ] **Step 1: Write the failing test**

`src/app/core/tour/tour-service.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PreferencesService } from '../preferences/preferences-service';
import { TourService } from './tour-service';

describe('TourService', () => {
  const prefsMock = { update: vi.fn().mockResolvedValue(undefined) };

  function make(): TourService {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: PreferencesService, useValue: prefsMock }],
    });
    return TestBed.inject(TourService);
  }

  beforeEach(() => prefsMock.update.mockClear());

  it('start() activates at step 0', () => {
    const tour = make();
    tour.start();
    expect(tour.active()).toBe(true);
    expect(tour.activeIndex()).toBe(0);
    expect(tour.current().id).toBe('welcome');
  });

  it('next() advances; past the last step it finishes and persists tourSeen', () => {
    const tour = make();
    tour.start();
    for (let i = 0; i < tour.steps.length - 1; i++) tour.next();
    expect(tour.activeIndex()).toBe(tour.steps.length - 1);
    tour.next();
    expect(tour.active()).toBe(false);
    expect(prefsMock.update).toHaveBeenCalledWith({ tourSeen: true });
  });

  it('prev() clamps at 0', () => {
    const tour = make();
    tour.start();
    tour.prev();
    expect(tour.activeIndex()).toBe(0);
  });

  it('skip() deactivates and persists tourSeen', () => {
    const tour = make();
    tour.start();
    tour.skip();
    expect(tour.active()).toBe(false);
    expect(prefsMock.update).toHaveBeenCalledWith({ tourSeen: true });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use 22.23.1 >/dev/null && npm test 2>&1 | tail -15`
Expected: FAIL — cannot resolve `./tour-service`.

- [ ] **Step 3: Implement the service**

`src/app/core/tour/tour-service.ts`:

```ts
import { Injectable, computed, inject, signal } from '@angular/core';
import { PreferencesService } from '../preferences/preferences-service';

export interface TourStep {
  id: 'welcome' | 'left-panel' | 'library' | 'right-panel' | 'credits' | 'bell';
  /** data-tour attribute value; null = centered card, no spotlight. */
  target: string | null;
  title: string;
  body: string;
  placement: 'right' | 'left' | 'top' | 'bottom' | 'center';
}

export const TOUR_STEPS: TourStep[] = [
  {
    id: 'welcome',
    target: null,
    placement: 'center',
    title: 'Welcome to Vansen',
    body: 'A 90-second tour of the studio. You can skip at any time.',
  },
  {
    id: 'left-panel',
    target: 'left-panel',
    placement: 'right',
    title: 'Create here',
    body: 'Describe it, pick a model, hit Generate. Everything you make starts here.',
  },
  {
    id: 'library',
    target: 'library',
    placement: 'top',
    title: 'Your library',
    body: 'Your creations land here. Click any image to edit, upscale, or make variations.',
  },
  {
    id: 'right-panel',
    target: 'right-panel',
    placement: 'left',
    title: 'Studio tools',
    body: 'Heal, cut out, expand, and more — the editing tools live in this panel.',
  },
  {
    id: 'credits',
    target: 'credits',
    placement: 'top',
    title: 'Credits & billing',
    body: 'Your balance and top-ups. Failed generations are refunded automatically.',
  },
  {
    id: 'bell',
    target: 'bell',
    placement: 'bottom',
    title: 'Notifications',
    body: "Refunds and job updates show up here. That's it — start creating.",
  },
];

/** Spotlight onboarding tour state. Finish/skip persists prefs.tourSeen. */
@Injectable({ providedIn: 'root' })
export class TourService {
  private readonly prefs = inject(PreferencesService);

  readonly steps = TOUR_STEPS;
  readonly activeIndex = signal(0);
  readonly active = signal(false);
  readonly current = computed(() => this.steps[this.activeIndex()]);

  start(): void {
    this.activeIndex.set(0);
    this.active.set(true);
  }

  next(): void {
    if (this.activeIndex() >= this.steps.length - 1) {
      this.finish();
      return;
    }
    this.activeIndex.update((i) => i + 1);
  }

  prev(): void {
    this.activeIndex.update((i) => Math.max(0, i - 1));
  }

  skip(): void {
    this.stop();
  }

  finish(): void {
    this.stop();
  }

  private stop(): void {
    this.active.set(false);
    void this.prefs.update({ tourSeen: true });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use 22.23.1 >/dev/null && npm test 2>&1 | tail -8`
Expected: PASS. **Do NOT commit.**

---

### Task 8: TourOverlay component

**Files:**
- Create: `src/app/shared/tour-overlay/tour-overlay.ts`
- Create: `src/app/shared/tour-overlay/tour-overlay.html`
- Create: `src/app/shared/tour-overlay/tour-overlay.css`
- Test: `src/app/shared/tour-overlay/tour-overlay.spec.ts`

**Interfaces:**
- Consumes: `TourService` (Task 7). Targets resolved via `document.querySelector('[data-tour="…"]')` — attributes added in Task 9.
- Produces: `<app-tour-overlay />`, rendered by Task 9 inside `@if (tour.active())`.

**Design notes for the implementer:**
- Spotlight = one absolutely-positioned div whose `box-shadow: 0 0 0 9999px <dim>` darkens everything around the cutout. Its `top/left/width/height` CSS-transition, so the spotlight *glides* between steps.
- The root is `position: fixed; inset: 0` and eats all pointer events — the app beneath is look-don't-touch during the tour.
- The computed geometry binds via `[style]` — this is the ONE allowed inline-style exception.
- Per-step inline-SVG illustration switches with the step; the `@switch` recreates the art node each step, which re-triggers its entrance animation.

- [ ] **Step 1: Write the failing test**

`src/app/shared/tour-overlay/tour-overlay.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PreferencesService } from '../../core/preferences/preferences-service';
import { TourService } from '../../core/tour/tour-service';
import { TourOverlay } from './tour-overlay';

describe('TourOverlay', () => {
  const prefsMock = { update: vi.fn().mockResolvedValue(undefined) };

  beforeEach(() => {
    prefsMock.update.mockClear();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: PreferencesService, useValue: prefsMock }],
    });
  });

  it('skips steps whose target is missing (none exist here → tour finishes)', () => {
    const tour = TestBed.inject(TourService);
    tour.start();
    const fixture = TestBed.createComponent(TourOverlay);
    fixture.detectChanges();
    // Welcome (no target) stays; advancing hits only missing targets → finish.
    tour.next();
    fixture.detectChanges();
    expect(tour.active()).toBe(false);
    expect(prefsMock.update).toHaveBeenCalledWith({ tourSeen: true });
  });

  it('Escape skips the tour', () => {
    const tour = TestBed.inject(TourService);
    tour.start();
    const fixture = TestBed.createComponent(TourOverlay);
    fixture.detectChanges();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(tour.active()).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use 22.23.1 >/dev/null && npm test 2>&1 | tail -15`
Expected: FAIL — cannot resolve `./tour-overlay`.

- [ ] **Step 3: Component class**

`src/app/shared/tour-overlay/tour-overlay.ts`:

```ts
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { TourService } from '../../core/tour/tour-service';

interface SpotRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

const SPOT_PAD = 8;
const CARD_GAP = 16;
const CARD_WIDTH = 336;
const CARD_EST_HEIGHT = 300;
const EDGE = 16;

@Component({
  selector: 'app-tour-overlay',
  templateUrl: './tour-overlay.html',
  styleUrl: './tour-overlay.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TourOverlay {
  readonly tour = inject(TourService);

  private readonly card = viewChild<ElementRef<HTMLElement>>('card');

  /** Spotlight rect in viewport px; null = centered step (welcome). */
  readonly rect = signal<SpotRect | null>(null);

  readonly stepNumber = computed(() => this.tour.activeIndex() + 1);
  readonly total = this.tour.steps.length;

  /** Inline geometry — the one allowed [style] exception (computed rects). */
  readonly spotStyle = computed(() => {
    const r = this.rect();
    if (!r) return null;
    return {
      top: `${r.top - SPOT_PAD}px`,
      left: `${r.left - SPOT_PAD}px`,
      width: `${r.width + SPOT_PAD * 2}px`,
      height: `${r.height + SPOT_PAD * 2}px`,
    };
  });

  readonly cardStyle = computed(() => {
    const r = this.rect();
    if (!r) return null;
    let top: number;
    let left: number;
    switch (this.tour.current().placement) {
      case 'right':
        top = r.top;
        left = r.left + r.width + SPOT_PAD + CARD_GAP;
        break;
      case 'left':
        top = r.top;
        left = r.left - SPOT_PAD - CARD_GAP - CARD_WIDTH;
        break;
      case 'top':
        top = r.top - SPOT_PAD - CARD_GAP - CARD_EST_HEIGHT;
        left = r.left + r.width / 2 - CARD_WIDTH / 2;
        break;
      default:
        top = r.top + r.height + SPOT_PAD + CARD_GAP;
        left = r.left + r.width / 2 - CARD_WIDTH / 2;
    }
    top = Math.max(EDGE, Math.min(top, window.innerHeight - CARD_EST_HEIGHT - EDGE));
    left = Math.max(EDGE, Math.min(left, window.innerWidth - CARD_WIDTH - EDGE));
    return { top: `${top}px`, left: `${left}px` };
  });

  constructor() {
    const remeasure = () => this.measure();
    const onKey = (e: KeyboardEvent) => this.onKeydown(e);
    window.addEventListener('resize', remeasure);
    window.addEventListener('scroll', remeasure, true);
    document.addEventListener('keydown', onKey);
    inject(DestroyRef).onDestroy(() => {
      window.removeEventListener('resize', remeasure);
      window.removeEventListener('scroll', remeasure, true);
      document.removeEventListener('keydown', onKey);
    });

    // Re-measure on each step; focus the card so keyboard nav lands there.
    effect(() => {
      this.tour.activeIndex();
      this.measure();
      queueMicrotask(() => this.card()?.nativeElement.focus());
    });
  }

  private measure(): void {
    if (!this.tour.active()) return;
    const step = this.tour.current();
    if (!step.target) {
      this.rect.set(null);
      return;
    }
    const el = document.querySelector(`[data-tour="${step.target}"]`);
    if (!el) {
      // Target not on screen (feature hidden) — move on to the next step.
      this.tour.next();
      return;
    }
    const r = el.getBoundingClientRect();
    this.rect.set({ top: r.top, left: r.left, width: r.width, height: r.height });
  }

  private onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') this.tour.skip();
    else if (e.key === 'ArrowRight' || e.key === 'Enter') this.tour.next();
    else if (e.key === 'ArrowLeft') this.tour.prev();
  }
}
```

- [ ] **Step 4: Template (with the per-step SVG illustrations)**

`src/app/shared/tour-overlay/tour-overlay.html`:

```html
<div class="tour-root">
  @if (rect()) {
    <div class="tour-spot" [style]="spotStyle()"></div>
  } @else {
    <div class="tour-dim"></div>
  }

  <div
    #card
    class="tour-card"
    [class.tour-card-center]="!rect()"
    [style]="cardStyle()"
    tabindex="-1"
    role="dialog"
    aria-modal="true"
    [attr.aria-label]="tour.current().title"
  >
    <p class="tour-kicker">Step {{ stepNumber() }} of {{ total }}</p>

    <div class="tour-art">
      @switch (tour.current().id) {
        @case ('welcome') {
          <svg viewBox="0 0 220 90" fill="none" aria-hidden="true">
            <circle cx="110" cy="45" r="26" class="art-accent" />
            <path d="M110 27v36M92 45h36M97 32l26 26M123 32l-26 26" class="art-accent" />
            <circle cx="110" cy="45" r="6" class="art-fill" />
            <path d="M30 45h44M146 45h44" class="art-line" stroke-dasharray="2 4" />
          </svg>
        }
        @case ('left-panel') {
          <svg viewBox="0 0 220 90" fill="none" aria-hidden="true">
            <rect x="30" y="18" width="120" height="54" rx="8" class="art-line" />
            <path d="M42 34h72M42 46h56M42 58h34" class="art-line" stroke-linecap="round" />
            <rect x="162" y="30" width="30" height="30" rx="8" class="art-accent" />
            <path d="M177 37v16M169 45h16" class="art-accent" />
          </svg>
        }
        @case ('library') {
          <svg viewBox="0 0 220 90" fill="none" aria-hidden="true">
            <rect x="28" y="20" width="48" height="48" rx="6" class="art-line" />
            <rect x="86" y="20" width="48" height="48" rx="6" class="art-accent" />
            <circle cx="100" cy="33" r="4" class="art-accent" />
            <path d="M89 63l13-15 9 9 8-8 12 14" class="art-accent" />
            <rect x="144" y="20" width="48" height="48" rx="6" class="art-line" />
          </svg>
        }
        @case ('right-panel') {
          <svg viewBox="0 0 220 90" fill="none" aria-hidden="true">
            <rect x="88" y="10" width="44" height="70" rx="8" class="art-line" />
            <path d="M103 22l14 14M117 22l-14 14" class="art-accent" />
            <rect x="103" y="44" width="14" height="14" rx="3" class="art-line" />
            <path d="M103 74h14M110 67v7" class="art-line" />
            <path d="M40 45h36M144 45h36" class="art-line" stroke-dasharray="2 4" />
          </svg>
        }
        @case ('credits') {
          <svg viewBox="0 0 220 90" fill="none" aria-hidden="true">
            <circle cx="96" cy="45" r="22" class="art-accent" />
            <path d="M96 33v24M90 39c0-3 12-3 12 0s-12 3-12 6 12 3 12 6" class="art-accent" />
            <path d="M132 28a24 24 0 1 1-8 34" class="art-line" />
            <path d="M126 22l8 9-12 3z" class="art-fill" />
          </svg>
        }
        @case ('bell') {
          <svg viewBox="0 0 220 90" fill="none" aria-hidden="true">
            <path d="M96 60h34c-5-4-6-9-6-17a11 11 0 0 0-22 0c0 8-1 13-6 17z" class="art-line" />
            <path d="M109 66a4 4 0 0 0 8 0" class="art-line" />
            <circle cx="128" cy="34" r="5" class="art-fill" />
            <rect x="146" y="26" width="48" height="18" rx="6" class="art-line" />
            <path d="M154 35h30" class="art-line" stroke-dasharray="2 3" />
          </svg>
        }
      }
    </div>

    <h3 class="tour-title">{{ tour.current().title }}</h3>
    <p class="tour-body">{{ tour.current().body }}</p>

    <div class="tour-dots" aria-hidden="true">
      @for (step of tour.steps; track step.id; let i = $index) {
        <span class="tour-dot" [class.tour-dot-on]="i <= tour.activeIndex()"></span>
      }
    </div>

    <div class="tour-actions">
      <button type="button" class="tour-skip" (click)="tour.skip()">Skip</button>
      <span class="tour-spacer"></span>
      @if (tour.activeIndex() > 0) {
        <button type="button" class="tour-back" (click)="tour.prev()">Back</button>
      }
      <button type="button" class="tour-next" (click)="tour.next()">
        {{ tour.activeIndex() === total - 1 ? 'Done' : 'Next' }}
      </button>
    </div>
  </div>
</div>
```

- [ ] **Step 5: Stylesheet**

`src/app/shared/tour-overlay/tour-overlay.css`:

```css
.tour-root {
  position: fixed;
  inset: 0;
  z-index: 90;
  animation: tour-fade-in 0.25s ease;
}

/* Full dim for the centered welcome step. */
.tour-dim {
  position: absolute;
  inset: 0;
  background: rgb(6 8 12 / 0.72);
}

/* Spotlight: transparent cutout, giant shadow dims everything else.
   top/left/width/height come from [style] (computed target rect). */
.tour-spot {
  position: absolute;
  border-radius: 12px;
  box-shadow: 0 0 0 9999px rgb(6 8 12 / 0.72);
  transition:
    top 0.25s ease,
    left 0.25s ease,
    width 0.25s ease,
    height 0.25s ease;
}

.tour-spot::after {
  content: '';
  position: absolute;
  inset: -3px;
  border: 2px solid color-mix(in oklch, var(--primary) 80%, transparent);
  border-radius: 14px;
  animation: tour-pulse 1.8s ease-out infinite;
}

.tour-card {
  position: absolute;
  width: 336px;
  padding: 18px 18px 14px;
  border: 1px solid color-mix(in oklch, var(--border) 80%, transparent);
  border-radius: 14px;
  background: color-mix(in oklch, var(--card) 94%, var(--background));
  box-shadow: 0 18px 48px rgb(0 0 0 / 0.35);
  outline: none;
  transition:
    top 0.25s ease,
    left 0.25s ease;
}

.tour-card-center {
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
}

.tour-kicker {
  margin: 0 0 10px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--muted-foreground);
}

.tour-art {
  display: flex;
  justify-content: center;
  margin-bottom: 12px;
  padding: 10px 0;
  border: 1px solid color-mix(in oklch, var(--border) 55%, transparent);
  border-radius: 10px;
  background: color-mix(in oklch, var(--muted) 30%, transparent);
}

.tour-art svg {
  width: 220px;
  height: 90px;
  animation: tour-art-in 0.3s ease;
}

.art-line {
  stroke: var(--muted-foreground);
  stroke-width: 1.5;
  opacity: 0.55;
}

.art-accent {
  stroke: var(--primary);
  stroke-width: 1.5;
}

.art-fill {
  fill: var(--primary);
  stroke: none;
}

.tour-title {
  margin: 0 0 4px;
  font-size: 15px;
  font-weight: 600;
  color: var(--foreground);
}

.tour-body {
  margin: 0 0 12px;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--muted-foreground);
}

.tour-dots {
  display: flex;
  gap: 5px;
  margin-bottom: 12px;
}

.tour-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: color-mix(in oklch, var(--muted-foreground) 30%, transparent);
  transition: background-color 0.2s ease;
}

.tour-dot-on {
  background: var(--primary);
}

.tour-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.tour-spacer {
  flex: 1;
}

.tour-skip,
.tour-back {
  border: 0;
  background: transparent;
  padding: 6px 8px;
  border-radius: 7px;
  font-size: 12px;
  color: var(--muted-foreground);
  cursor: pointer;
}

.tour-skip:hover,
.tour-back:hover {
  color: var(--foreground);
  background: color-mix(in oklch, var(--muted) 55%, transparent);
}

.tour-next {
  border: 0;
  padding: 7px 16px;
  border-radius: 8px;
  background: var(--primary);
  color: var(--primary-foreground);
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
}

.tour-next:hover {
  filter: brightness(1.12);
}

@keyframes tour-fade-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@keyframes tour-pulse {
  0% {
    transform: scale(1);
    opacity: 0.9;
  }
  70% {
    transform: scale(1.035);
    opacity: 0;
  }
  100% {
    opacity: 0;
  }
}

@keyframes tour-art-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .tour-root,
  .tour-art svg {
    animation: none;
  }
  .tour-spot::after {
    animation: none;
    opacity: 0.9;
  }
  .tour-spot,
  .tour-card,
  .tour-dot {
    transition: none;
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use 22.23.1 >/dev/null && npm test 2>&1 | tail -8`
Expected: PASS (missing-target cascade finishes the tour; Escape skips). If the effect does not flush on `fixture.detectChanges()`, call `TestBed.tick()` before the assertions instead. **Do NOT commit.**

---

### Task 9: Workspace + profile-menu tour integration

**Files:**
- Modify: `src/app/features/workspace/workspace-page.ts` (imports, `imports:` array, injects, constructor `refresh().then`, new `maybeStartTour` / `onStartTour` methods)
- Modify: `src/app/features/workspace/workspace-page.html` (`data-tour` attrs, profile-menu binding, overlay at shell end)
- Modify: `src/app/shared/profile-menu/profile-menu.ts:5,17,37-38`
- Modify: `src/app/shared/profile-menu/profile-menu.html:52-56`

**Interfaces:**
- Consumes: `TourService` (Task 7), `TourOverlay` (Task 8), `Prefs.tourSeen` (Task 3), bell's `data-tour="bell"` (Task 6).
- Produces: auto-run on first load, "Take the tour" replay item.

- [ ] **Step 1: Profile-menu replay item**

In `src/app/shared/profile-menu/profile-menu.ts`:
- Change the lucide import line to: `import { lucideCompass, lucideLogOut, lucidePlus, lucideSettings } from '@ng-icons/lucide';`
- Change `provideIcons` to: `provideIcons({ lucideSettings, lucideLogOut, lucidePlus, lucideCompass })`
- Add after `readonly topUp = output<void>();`:

```ts
  readonly startTour = output<void>();
```

In `src/app/shared/profile-menu/profile-menu.html`, after the Settings link (`</a>`) and before the second `<hlm-dropdown-menu-separator />`, add:

```html
    <button hlmDropdownMenuItem (triggered)="startTour.emit()">
      <ng-icon name="lucideCompass" size="15" />
      Take the tour
    </button>
```

- [ ] **Step 2: Workspace class wiring**

In `src/app/features/workspace/workspace-page.ts`:

Add imports:

```ts
import { TourService } from '../../core/tour/tour-service';
import { TourOverlay } from '../../shared/tour-overlay/tour-overlay';
```

Add `TourOverlay,` to the component `imports:` array. Add a **public** inject (template reads `tour.active()`), next to the other injects:

```ts
  readonly tour = inject(TourService);
```

In the constructor, extend the boot chain — change:

```ts
    void this.refresh().then(() => {
      this.handleCheckoutReturn();
      this.poller.watch();
      if (editParam) void this.enterEdit(editParam);
    });
```

to:

```ts
    void this.refresh().then(() => {
      this.handleCheckoutReturn();
      this.poller.watch();
      if (editParam) void this.enterEdit(editParam);
      else this.maybeStartTour();
    });
```

Add the two methods (near `signOut`):

```ts
  /** First-load onboarding: only when the server-synced pref says unseen. */
  private maybeStartTour(): void {
    if (this.prefsService.prefs().tourSeen || this.suspended()) return;
    // Let the first frame paint so data-tour targets have settled rects.
    requestAnimationFrame(() => requestAnimationFrame(() => this.tour.start()));
  }

  /** Replay from the profile menu. Tour targets only exist in library mode. */
  onStartTour(): void {
    if (this.mode() === 'edit') this.exitEdit();
    if (this.mode() !== 'library') return; // user kept unsaved edits
    this.tour.start();
  }
```

- [ ] **Step 3: Workspace template wiring**

In `src/app/features/workspace/workspace-page.html`:

1. Left panel target — change `<div class="side-scroll">` to:

```html
    <div class="side-scroll" data-tour="left-panel">
```

2. Credits target + replay binding — change the profile-menu line to:

```html
      <app-profile-menu
        variant="bar"
        data-tour="credits"
        (topUp)="topUp()"
        (signOut)="signOut()"
        (startTour)="onStartTour()"
      />
```

3. Library target — change `<main class="content">` to:

```html
    <main class="content" data-tour="library">
```

4. Right panel target — add the attribute to the `<app-right-panel` opening tag:

```html
  <app-right-panel
    data-tour="right-panel"
    [editing]="mode() === 'edit'"
```

(The bell already carries `data-tour="bell"` from Task 6.)

5. Overlay — after the `<app-notification-toast …/>` line (still inside `.shell`), add:

```html
  @if (tour.active()) {
    <app-tour-overlay />
  }
```

- [ ] **Step 4: Full verification**

Run: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use 22.23.1 >/dev/null && npm test 2>&1 | tail -5 && npx ng build 2>&1 | tail -6`
Expected: all tests PASS, build succeeds.

- [ ] **Step 5: Manual smoke check (report, don't commit)**

Serve the app (`npx ng serve`) if a browser is available, or state the checklist for the user:
- Fresh account (or `tourSeen:false`): tour auto-runs after workspace load; spotlight glides left panel → library → right panel → credits → bell; Esc skips; finishing persists (reload → no tour).
- Profile menu → "Take the tour" replays; from edit mode it returns to the library first.
- Bell shows unread badge after a generation completes; failed generation shows "Refunded $X.XX" toast and history row; clicking a row opens the detail overlay; "Mark all read" clears the badge.

**Do NOT commit — the user commits personally.**
