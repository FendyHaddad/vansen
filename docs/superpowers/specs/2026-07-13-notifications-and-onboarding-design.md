# Notifications Center + Onboarding Tour — Design

**Date:** 2026-07-13
**App:** vansen (Angular workspace, not backoffice)
**Status:** approved, ready for plan

## Goal

Two in-app UX features, one combined spec:

1. **Notification center** — a top-bar bell that tells users about generation
   events, most importantly that a *failed generation was refunded*. Also covers
   "generation ready" and "moderation blocked". Persistent history + unread
   badge + arrival toast.
2. **Onboarding tour** — a Photoshop-style spotlight coach-marks walkthrough that
   dims the screen and points at the real left panel / library / right panel /
   credits / bell, one step at a time. Auto-runs on first workspace load,
   replayable from the profile menu.

## Global Constraints

- Angular components use **separate** `.ts` + `.html` + `.css` files. Never
  inline templates or styles.
- Prefer stylesheet classes over inline `style` attributes (the tour overlay's
  dynamic spotlight geometry is the one allowed exception — computed rects must
  bind to `[style]`).
- **No backend / DB change.** Notifications persist in `localStorage` per-uid;
  the tour-seen flag rides the existing server-synced `profiles.prefs` jsonb via
  `PreferencesService`.
- Client never does money math — refund amount displayed comes from the failed
  generation's server-assigned `priceUsd`; balance is refreshed from the server.
- Build: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 22.23.1 && npx ng build`
- Tests: `npm test` (never bare `npx vitest run` — it falsely fails TestBed specs).

## Grounding facts (current code)

- `GenerationStatus` enum = `pending` | `done` | `failed` (`core/enums.ts`).
- `GenerationStore.applyJobUpdates(updates)` (`core/generations/generation-store.ts`)
  merges poll results into `itemsSig`. It already has the **old** list and the
  **new** updates in scope — the natural diff point for status transitions.
- `JobPoller` (`core/jobs/job-poller.ts`) drives polling; no change needed.
- Moderation block is a **synchronous** `POST /generations` rejection surfaced in
  `workspace-page.ts` `showError` (code path around the `insufficient_balance` /
  moderation branch), NOT a poll transition.
- `LedgerService` (`core/ledger/ledger-service.ts`) holds balance; `setBalance()`
  is the only writer. Balance after a refund must be refreshed from the server
  (profile fetch) — `applyJobUpdates` currently does not touch balance.
- `PreferencesService` (`core/preferences/preferences-service.ts`) is
  server-backed (`profiles.prefs` jsonb) with a localStorage cache and
  `update(patch)` → `PUT /prefs`. Adding a `tourSeen` field rides this verbatim.
- Workspace shell (`features/workspace/workspace-page.html`) is 3 columns:
  `aside.sidebar` (left panel + profile-menu at foot), `.main-col`
  (`header.topbar` with `.topbar-right` slot + `main.content` = library/edit),
  and `app-right-panel`. `notice()` inline banner already exists.
- `profile-menu` (`shared/profile-menu`) is a spartan `hlmDropdownMenu`; the
  bell dropdown copies this pattern.

---

## Feature 1 — Notification center

### Data model

```ts
type NotificationKind = 'refund' | 'ready' | 'blocked';

interface AppNotification {
  id: string;          // crypto.randomUUID()
  kind: NotificationKind;
  title: string;       // e.g. "Refunded $0.10"
  detail?: string;     // e.g. "FLUX · create failed — credits returned"
  genId?: string;      // generation to open on click (ready/refund)
  at: string;          // ISO
  read: boolean;
}
```

### Store — `core/notifications/notification-store.ts` (root singleton)

- `list = signal<AppNotification[]>([])`, newest first, capped at 50.
- `unreadCount = computed(() => list().filter(n => !n.read).length)`.
- `latestToast = signal<AppNotification | null>(null)` — set by `add()`, cleared
  by the toast host after display; drives the arrival toast.
- `add(input: Omit<AppNotification,'id'|'at'|'read'>)`: prepend with generated
  id/at/read=false, trim to 50, persist, set `latestToast`.
- `markRead(id)`, `markAllRead()`, `clearToast()`.
- Persist per-uid: `localStorage['vansen.notifications.' + uid]` (uid via the
  same `currentUid()` helper generation-store uses, or ProfileStore). Load in
  constructor; guard JSON with try/catch.
- `reset()` on sign-out (called from the same place `GenerationStore.reset()` /
  `LedgerService.reset()` are called).

### Detection wiring

**In `GenerationStore.applyJobUpdates`** — before/while merging, diff by id:
- old `pending` → new `done`: `notifications.add({ kind:'ready', title:'Image ready', detail: familyName+' · '+op, genId })`.
- old `pending` → new `failed`: `notifications.add({ kind:'refund', title:'Refunded $'+priceUsd, detail: familyName+' · '+op+' failed — credits returned', genId })` **and** trigger a balance refresh from the server (profile refetch — see below).
- Inject `NotificationStore` into `GenerationStore`. Guard against duplicate
  notifications if the same terminal item appears in a later poll (only emit when
  the *old* item was `pending`; terminal items are never pending again).

**Balance refresh after refund:** add `LedgerService.refreshBalance()` that
re-reads the authoritative balance. Simplest: reuse the profile endpoint the app
already calls at boot (ProfileStore) — expose/refresh it and let it call
`ledger.setBalance()`. Plan will confirm the exact profile refresh method; if
none is cleanly reusable, `refreshBalance()` does a lightweight `GET /profile`
and sets balance. No new server route.

**Moderation block** — in `workspace-page.ts` where the moderation error code is
handled, also call `notifications.add({ kind:'blocked', title:'Blocked by moderation', detail:<reason/route> })`. Keep the existing inline `notice()` too.

### UI

**`shared/notification-bell`** (`.ts`/`.html`/`.css`) placed in
`workspace-page.html` `.topbar-right`:
- Spartan `hlmDropdownMenuTrigger` bell button (`lucideBell`) with an unread
  badge (hidden when `unreadCount()===0`).
- Dropdown: header "Notifications" + "Mark all read" (shown when unread>0); a
  scrollable list of rows — kind icon (`lucideRotateCcw` refund /
  `lucideImage` ready / `lucideShieldAlert` blocked), title, `detail`, relative
  time; **bold when unread**. Empty state "Nothing yet."
- Row click: `markRead(n.id)` then, if `genId`, emit an `open` event the
  workspace binds to open the detail overlay for that generation.
- Relative-time helper mirrors backoffice `timeAgo`.

**Toast** — `shared/notification-toast` (`.ts`/`.html`/`.css`), one host near the
top of the workspace shell. Watches `notifications.latestToast()`; on a new value
shows a 4s auto-dismiss toast (kind icon + title), then `clearToast()`. Clicking
it opens the bell dropdown or the generation; auto-dismiss via a timer that
resets on each new toast.

**Multiple events in one poll tick:** a single `applyJobUpdates` can complete
several jobs at once. All become notifications (badge counts them), but the
toast shows only the **last** one added, with the title suffixed
"(+N more)" when more than one landed in the same tick. No toast stacking —
the bell history is the full record.

### Tests

- Store: `add` prepends/caps at 50/persists; `markRead`/`markAllRead` flip flags
  and update `unreadCount`; reload from localStorage.
- `applyJobUpdates`: `pending→done` emits one `ready`; `pending→failed` emits one
  `refund` whose title contains the `priceUsd`; a repeat poll of an
  already-terminal item emits nothing; refund path calls balance refresh.
- Toast: two adds in one tick → single toast titled with "(+1 more)".

---

## Feature 2 — Onboarding coach-marks tour

### Service — `core/tour/tour-service.ts` (root singleton)

```ts
interface TourStep { target: string; title: string; body: string; placement: 'right'|'left'|'top'|'bottom'; }
```
- `steps: TourStep[]` (see copy below), `activeIndex = signal(0)`,
  `active = signal(false)`.
- `start()` sets index 0 + active true. `next()`/`prev()` clamp; `next()` past the
  last step calls `finish()`. `skip()` and `finish()` set active false and call
  `prefs.update({ tourSeen: true })`.
- Injects `PreferencesService`.

### Trigger

- In `workspace-page.ts` init: after prefs are known, if `!prefs().tourSeen`
  and account not suspended → `tour.start()`. **Timing:** start only after the
  first render has settled (`afterNextRender` + one `requestAnimationFrame`) so
  `getBoundingClientRect` measures real layout, not a mid-boot frame.
- **Replay:** new profile-menu dropdown item "Take the tour" (`lucideCompass`)
  emitting a `startTour` output the workspace binds to. The workspace handler
  first **exits edit/canvas mode back to the grid view** (edit mode hides the
  library and swaps the right panel — tour targets must exist), then calls
  `tour.start()`.
- Add `tourSeen: boolean` to `Prefs` + `DEFAULTS` (`tourSeen: false`) in
  `preferences-service.ts`.

### Overlay — `shared/tour-overlay` (`.ts`/`.html`/`.css`)

- Rendered once in `workspace-page.html` (sibling of the columns), shown when
  `tour.active()`.
- Resolves the current step's `target` via `document.querySelector('[data-tour="…"]')`
  and `getBoundingClientRect()`. Spotlight = full-screen dim with a transparent
  cutout over the target (SVG `<mask>` or four dim rects around the rect —
  computed geometry bound with `[style]`, the allowed inline-style exception).
- Tooltip card near the target per `placement`: uppercase micro-title
  "STEP N OF M" (matching the app's panel design language — sectioned rails,
  uppercase micro-titles, muted labels), step illustration (see Visual design),
  title, body, progress dots, **Skip** (left), **Back** (if index>0),
  **Next / Done** (right).
- **The overlay blocks all interaction with the app beneath** (full-screen
  element captures pointer events, including inside the cutout — the spotlight
  is look-don't-touch). Only the tooltip card's buttons are interactive.
- **Keyboard:** `Esc` = skip, `→`/`Enter` = next, `←` = back. Listener on the
  overlay host while active; focus moves to the card on each step (also covers
  basic a11y).
- Recompute rects on `window` `resize` + `scroll` (listeners added on activate,
  removed on deactivate). If a target is missing, skip to the next resolvable
  step.
- `data-tour` attributes to add: `left-panel` (the generate panel), `library`
  (center content), `right-panel`, `credits` (profile-menu bar button), `bell`
  (the new notification bell).

### Visual design (the Photoshop-quality pass)

The tour must not read as gray boxes with text. Required visual elements, all
CSS/inline-SVG — **no external assets, no new dependencies**:

1. **Per-step illustration** — each step's card leads with a small inline SVG
   vignette (~220×90, drawn in-template, stroked in theme accent + muted
   colors, `currentColor`/CSS-variable tinted so it follows the app theme):
   - `welcome`: Vansen wordmark/spark motif with radiating lines.
   - `left-panel`: prompt field + sparkle button mini-diagram.
   - `library`: 3-tile image grid with one tile highlighted.
   - `right-panel`: tool icons column (heal patch, crop, wand).
   - `credits`: coin + circular refund arrow.
   - `bell`: bell with badge dot + toast slice.
   Illustrations live in the overlay template behind an `@switch` on the step
   id — separate-file rule still holds (they're template SVG, not styles).
2. **Animated spotlight** — the cutout rect and tooltip card CSS-transition
   (~250ms ease) between steps instead of jumping; dim layer fades in on
   `start()` and out on finish/skip.
3. **Pulse ring** — a soft animated ring (CSS keyframe scale+fade) around the
   spotlight rect, drawing the eye to the highlighted region.
4. **Progress dots** — M dots under the body copy, filled up to N; doubles as
   the sense of "how much is left".
5. **Card entrance** — small rise+fade keyframe on each step change.
6. Illustration + animations respect `prefers-reduced-motion: reduce`
   (transitions/keyframes off, instant positioning).

### Step copy

1. `welcome` (centered, no target) — "Welcome to Vansen. 90-second tour of the studio."
2. `left-panel` — "Describe it, pick a model, hit Generate. Everything you make starts here."
3. `library` — "Your creations land here. Click any image to edit, upscale, or make variations."
4. `right-panel` — "Studio editing tools — heal, cut out, expand, and more — live in this panel."
5. `credits` — "Your balance and top-ups. Failed generations are refunded automatically."
6. `bell` — "Refunds and job updates show up here. That's it — start creating."

(Step 1 with no `target` renders a centered card, no spotlight.)

### Tests

- `start()` sets active/index0; `next()` advances and past-last calls `finish()`;
  `finish()`/`skip()` set active false and call `prefs.update({tourSeen:true})`.
- `Prefs` defaults include `tourSeen:false`; server prefs merge preserves it.
- Overlay: missing target skips to next resolvable step; Esc calls `skip()`.

---

## Out of scope

- No server notifications table / push. Notifications are device-local history.
- No email/webhook delivery.
- No per-notification deep settings; no tour analytics.
- Video-generation events (Phase 4b) — the `ready`/`refund`/`blocked` kinds cover
  current image flows; new kinds can be added later without schema change.
