# Password recovery — verification log

P8 Task 6 Step 5. Recorded 2026-09-21.

**Status: PARTIAL. Every check that needs a real email or a second device is
BLOCKED, not skipped.** The two reasons are recorded in the release-hardening
blockers: there is no staging Supabase project, and `supabase start` cannot run
because two migrations share the `0008` prefix (`0008_age_gate.sql` and
`0008_credit_plans.sql`), so there is no local Inbucket mailbox either. Nothing
below was simulated or assumed — the blocked rows say blocked.

## What was verified

| Check | Result | How |
|---|---|---|
| Reset email goes to this origin's `/reset`, never a caller-supplied URL | **PASS** | `auth-service.spec.ts` — asserts the exact `redirectTo`. A query-parameter redirect would turn our own email into a way to deliver someone else's code to an attacker's page. |
| Resend uses `{type:'signup', email, options:{emailRedirectTo}}` | **PASS** | `auth-service.spec.ts` |
| Unknown address answers exactly as a known one | **PASS** | Service and page specs, both directions: resolved success, and the vendor's own `User not found` swallowed. |
| A rate-limited address answers the same way | **PASS** | `auth-service.spec.ts` — a different answer here says "this address is worth rate limiting", which is the same disclosure by another route. |
| Address never reflected back into the page | **PASS** | `recover-page.spec.ts` |
| Vendor wording never reaches the customer | **PASS** | `auth-service.spec.ts` (`ECONNREFUSED` case) and `recover-page.spec.ts` |
| No session at all cannot reset a password | **PASS** | `auth-service.spec.ts` |
| An ordinary signed-in session cannot reset a password | **PASS** | `auth-service.spec.ts` — being signed in is not permission to set a password. |
| A signed in, opening B's recovery link, cannot reset | **PASS** | `auth-service.spec.ts` — the recovery names B, the session is A, so the update is refused. |
| A reused link never changes the password twice | **PASS** | `auth-service.spec.ts` — the grant is cleared on success. |
| An expired recovery is refused | **PASS** | `auth-service.spec.ts`, 30-minute TTL, under fake timers. Mutating the check to `if (false)` fails the suite. |
| Sign-out or another identity drops the recovery | **PASS** | `auth-service.spec.ts` |
| Cancel / navigating away drops the recovery | **PASS** | `auth-service.spec.ts` and `reset-page.spec.ts` (`ngOnDestroy`) |
| A short password never reaches the vendor | **PASS** | `auth-service.spec.ts` and `reset-page.spec.ts` |
| A failed update stays retryable and does not route to the app | **PASS** | `reset-page.spec.ts` |
| The recovery code is scrubbed from the URL | **PASS** | `reset-page.spec.ts` (PKCE query and implicit fragment) and checked live in the browser: `/reset?code=should-not-persist` became `/reset`. |
| Arriving at `/reset` with no recovery shows no form | **PASS** | `reset-page.spec.ts`, and confirmed in the browser. |
| No recovery token in logs, analytics or persistence | **PASS** | `auth-service.spec.ts` inspects `localStorage` + `sessionStorage`; the only public signal is `recoveryPending()`, a boolean that names nobody. |

Four mutations were run against the gates — identity match, expiry, minimum
length, and grant invalidation. All four fail the suite, so none of them is
decoration.

## What is BLOCKED

| Check | Blocked by |
|---|---|
| A real link delivered to a real mailbox, opened on the same device | No staging project; no local Inbucket (`supabase start` blocked by the duplicate `0008` prefix). |
| The same link opened in a different browser or on another device | Same. |
| A genuinely expired link (server-side expiry, not the client TTL) | Same. Only the client's 30-minute grant is covered above. |
| A genuinely reused link (server-side single use) | Same. |
| After a successful reset, the OLD password no longer works | Same. |
| Rapid repeats bypassing the local cooldown, against the configured server rate limit | Same — and the limit itself is not configured yet. |
| Confirmation resend and signup resumption end to end | Same. |
| Email template, sender identity and the callback allowlist | Supabase dashboard configuration, not in this repo. |

## Configuration P9 must do before release

1. **Redirect allowlist.** Add `<production origin>/reset` and
   `<production origin>/confirm` to the Supabase Auth URL configuration.
   Until they are on the allowlist the emails will land on the site root and
   the recovery will silently not happen.
2. **Server-side rate limits.** Set the recovery and resend limits in the
   Supabase dashboard. The client has a "do not submit twice" guard, which is
   convenience only — it is a disabled button, not an abuse limit, and anyone
   calling the API directly bypasses it. Prove the configured limit holds
   against direct API repeats, and keep tokenized URLs out of the evidence.
3. **Email templates and sender.** Both templates and the sender identity are
   defaults today.
4. **Link lifetime.** Decide the server-side expiry and make sure it is not
   longer than the 30-minute client grant, or the page will say "expired" while
   the link still works.

## Also outstanding

Enable leaked-password protection once the project is on Supabase Pro — the
toggle is paid-gated and is tracked separately.
