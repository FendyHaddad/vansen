# Age Gate (18+) — Design

Date: 2026-07-17
Status: Approved, pending implementation plan

## Problem

Vansen collects no age information at signup. As an AI image generator with
adult-content moderation risk, it must not allow minors to hold accounts. US
COPPA (under-13 rule) and EU GDPR Article 8 (child-consent rule) both require an
age check. A single global **18+** requirement satisfies both by a wide margin
and avoids parental-consent flows and per-country logic.

## Decisions (locked)

- **Policy:** 18+ globally. No per-region threshold, no parental consent.
- **Collection:** Neutral date-of-birth entry (FTC neutral-age-screen — no hint
  at the passing age). Store the full `birth_date`; defensible in an audit.
- **Enforcement point:** Post-login onboarding gate. Runs after auth, so it
  covers email/password and Google OAuth identically.
- **Under-18 handling:** Reject, delete the account (do not retain a minor's
  data), sign out. A **two-step confirm** precedes the irreversible delete.

## Current-state facts

- Two signup paths: email/password form ([login-page.ts](../../../src/app/features/auth/login-page.ts))
  and Google OAuth ([auth-service.ts](../../../src/app/core/auth/auth-service.ts)).
  OAuth creates the account on redirect with **no form step** — an age field on
  the login form alone cannot cover it. This is why the gate is post-login.
- Profile row is auto-created by DB trigger `handle_new_user()` on `auth.users`
  insert ([0007_owner_tier.sql](../../../supabase/migrations/0007_owner_tier.sql)).
  No client-side onboarding step exists today.
- `profiles` has no birthdate/age column
  ([0001_foundation_schema.sql](../../../supabase/migrations/0001_foundation_schema.sql)).
- `/app` is protected by `authGuard` only ([auth-guard.ts](../../../src/app/core/auth/auth-guard.ts)).
- Account deletion already exists: `DELETE /profile` cancels Stripe →
  `fn_delete_account` RPC → `admin.auth.admin.deleteUser`
  ([api/index.ts](../../../supabase/functions/api/index.ts) L378-403). The
  under-18 branch reuses this exact sequence.

## Architecture

### 1. Data model — migration `0008_age_gate.sql`

```sql
alter table public.profiles add column birth_date date;
alter table public.profiles add column age_confirmed_at timestamptz;
```

- `birth_date IS NULL` = not yet gated. No trigger change.
- Existing users (null birth_date) are retroactively gated on next login —
  desirable for compliance. The owner/seed account is gated once, like anyone.

### 2. API — `POST /profile/age` (new, in `api/index.ts`)

- Body: `{ birthDate: "YYYY-MM-DD" }`.
- Validate: strict `YYYY-MM-DD` format; a real calendar date; not in the
  future; not older than 120 years. Reject malformed → `400 invalid_payload`.
- **Server computes age** (authoritative) with correct month/day rollover:
  `age = year diff, minus 1 if this year's birthday hasn't occurred yet`.
- **age ≥ 18** → `update profiles set birth_date = $1, age_confirmed_at = now()
  where id = userId` → `{ ok: true }`.
- **age < 18** → run shared `deleteAccount(userId)` helper (below) →
  `403 { error: { code: 'underage' } }`.
- Refactor: extract the Stripe-cancel + `fn_delete_account` +
  `auth.admin.deleteUser` sequence from `DELETE /profile` into one
  `deleteAccount(c, userId)` helper. Both `DELETE /profile` and the underage
  branch call it — one deletion path, no drift.

`GET /profile` response gains **`ageConfirmed: !!profile.birth_date`** (a
boolean). The full DOB stays server-side; the client only needs the flag for
guard/routing.

### 2b. Server-side enforcement — age-gate middleware

Client guards are UX, not enforcement: any holder of a valid JWT can call the
API directly. A middleware registered **after** the auth middleware blocks every
route for un-gated users, except the endpoints needed to pass the gate or
leave:

- Exempt: `GET /profile`, `POST /profile/age`, `DELETE /profile`.
- Everything else: if `profiles.birth_date IS NULL` →
  `403 { error: { code: 'age_unconfirmed' } }`.
- Perf: a warm-isolate `Set<userId>` memo (same pattern as `signedUrlMemo`)
  skips the DB read after the first confirmation. Safe to cache because the
  flag only ever transitions unset → set; `deleteAccount` evicts the entry.
- Rollout note: users already inside `/app` at deploy time get
  `403 age_unconfirmed` on their next generate/billing call until they reload
  and pass the onboarding gate. Acceptable — the generic API error surfaces,
  and a reload routes them to `/onboarding`.

### 3. Routing + guard (Angular)

- New route `/onboarding` (behind `authGuard`), lazy `OnboardingPage`.
- New `ageGuard: CanActivateFn` on `/app`, `/app/edit/:id`, `/app/settings`:
  1. `await auth.whenReady()`; not authed → `/login` (authGuard already does
     this; ageGuard runs after and assumes authed).
  2. **Short-circuit:** if the store is loaded and `ageConfirmed` is already
     true, allow immediately — no network. The flag only ever goes
     unset → set, so a cached true can't be stale. Otherwise
     `await ProfileStore.load()` (authoritative GET).
  3. `profile.ageConfirmed` false → redirect `/onboarding`. Else allow.
- `/onboarding` self-guards: if `ageConfirmed` already true → redirect `/app`
  (prevents re-entry).
- Guard order on `/app`: `[authGuard, ageGuard]`.

### 4. Onboarding UI — `features/onboarding/` (ts + html + css, separate files)

- **Neutral** heading: "Enter your date of birth." No mention of 18 until/unless
  rejected. Day / Month / Year `<select>`s (avoids locale ambiguity of a free
  date field); months shown by **name** (January…December), not number.
- **Sign-out escape hatch:** a "Sign out instead" link below the form — a user
  unwilling to provide a DOB must not be trapped. Signs out and returns to `/`.
- Impossible dates (e.g. Feb 30) get their own error ("that date doesn't
  exist"), distinct from the blank-fields error.
- Component styles are self-contained (Angular component CSS is scoped —
  `.site-brand` / `.muted` / `.linkish` from the login page are NOT reusable;
  the onboarding stylesheet defines its own).
- Submit flow:
  1. Client computes age locally **only to decide whether to warn**.
  2. If local age < 18 → show **two-step confirm** dialog: "The date you entered
     is under 18. Vansen is 18+, so continuing will permanently delete this
     account. This can't be undone." Buttons: Cancel / Continue.
  3. On confirm (or if local age ≥ 18) → `POST /profile/age`.
  4. `{ ok: true }` → `ProfileStore` sets `ageConfirmed`, navigate `/app`.
  5. `403 underage` (server authoritative — deletion has happened) → terminal
     rejection screen: "You must be 18 or older to use Vansen. Your account has
     been removed." Then `ProfileStore.reset()` + `AuthService.signOut()`.
- The local pre-check is UX only; the server recomputes and is the sole deleter.
  A user who bypasses the client still hits the server gate.

### 5. Reuse summary

- Backend: shared `deleteAccount(c, userId)` helper (extracted from
  `DELETE /profile`).
- Frontend: existing `ProfileStore.reset()`, `AuthService.signOut()`,
  `ProfileStore.load()`, and the `ApiService` post/get.

## Data flow

```
login (email or OAuth) → session, profile row exists, birth_date null
  → ageGuard on /app: ProfileStore.load(), ageConfirmed false
  → redirect /onboarding
  → user enters DOB, submits
      ├─ local age ≥ 18 → POST /profile/age → server age ≥ 18
      │     → birth_date + age_confirmed_at set → /app
      └─ local age < 18 → two-step confirm → POST /profile/age → server age < 18
            → deleteAccount() → 403 underage → rejection screen → signOut
```

## Error handling

- Malformed / implausible DOB → `400`, inline field error, no account change.
- Network failure on submit → inline retry, no state change (idempotent: the
  update is a plain overwrite; delete only fires on a confirmed under-18).
- `deleteAccount` partial failure (e.g. Stripe cancel throws) → returns the same
  `400 delete_failed` as `DELETE /profile` today; onboarding surfaces "couldn't
  complete — try again" and does not sign out.

## Testing

- **API:** age computation boundary (exactly 18 today; birthday tomorrow = 17;
  birthday yesterday = 18; Feb-29 births), format/plausibility rejects, ≥18
  writes the columns, <18 triggers `deleteAccount` and returns 403. Middleware:
  un-gated user calling any non-exempt route gets `403 age_unconfirmed`; the
  three exempt routes work. (No Deno test harness exists — verified manually
  post-deploy; the age math itself is unit-tested via the mirrored client util.)
- **Guard:** ageConfirmed false redirects to `/onboarding`; true allows `/app`;
  `/onboarding` redirects to `/app` when already confirmed.
- **Onboarding component:** local <18 shows confirm dialog; confirm posts;
  ≥18 posts directly; 403 shows rejection + signs out. Use `npm test` (project
  test runner) — bare vitest falsely fails TestBed specs.

## Out of scope

- Parental consent flows (not needed at 18+).
- Per-country thresholds.
- ID/document age verification (self-declared DOB only, industry standard for
  this tier).
- Re-verification / DOB editing after confirmation (one-time gate).

## Deployment notes

- Apply `0008_age_gate.sql` via Supabase MCP.
- Redeploy `api` edge function after adding `/profile/age` (bundle all `_shared/`
  per CLAUDE.md).
- No Stripe or provider changes.
