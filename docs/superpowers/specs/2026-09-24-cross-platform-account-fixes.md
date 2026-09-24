# Cross-platform account fixes

Date: 2026-09-24.

Source: the research in `.superpowers/sdd/signup-sync-research.md`, which answers two questions: what happens when a user signs up on mobile first versus on the web first, and how the two stay in sync. Issue numbers below refer to its ranked list.

- **#1 CORS:** fixed in `7e46c8d`. It is not deployed yet.
- **Owner-only items:**
  - #4, Apple accounts on the web, is a decision (see the chat).
  - #6 needs the hosted GoTrue minimum password length set to 8. That is a dashboard security setting.
  - #10 is store policy.

## Shared contract

`GET /profile` gains one top-level field:

```
subscriptionSource: "stripe" | "app_store" | null
```

- `null` means there is no subscription row.
- Otherwise the value is the rail that wrote the row, whatever its status.
- Web and mobile use it to decide who manages the plan. When the source is `app_store`, the user manages the plan in the App Store, and the link is `https://apps.apple.com/account/subscriptions`.

## Task A: backend and web billing (money, gets its own review)

- **#2:** `POST /billing/subscribe` refuses with 409 `subscribed_in_app_store` while an entitled App Store subscription exists. Stripe checkout is never created in that case.
- **#3:** add `subscriptionSource` to `/profile`.
  - The web billing tab shows "Managed in the App Store" with the link, instead of the Stripe cancel and portal controls.
  - The Stripe cancel and portal endpoints return 409 `managed_in_app_store` for App Store rows. Today they return 400 `no_subscription`.
- **#14:** `isEntitled` also requires `current_period_end` to be null or later than now minus 3 days (grace for late renewal webhooks). Existing Stripe behaviour inside that window is unchanged. Tests cover the boundary.
- **#15:**
  - `/billing/overview` doesn't create a Stripe customer for a user whose subscription source is `app_store`.
  - Offers don't stack across rails: the first-purchase offer is refused when an App Store subscription was ever recorded.

  Keep both small. If one needs a migration, list it and don't apply it.
- Web `apiErrorText` entries for the new codes.

## Task B: mobile

- **#3:** when `subscriptionSource` is `app_store`, the billing screen shows "Managed in the App Store" plus the link, instead of the Stripe Cancel. It maps `managed_in_app_store` and `subscribed_in_app_store`.
- **#5:** subscribed means `profile.hasPlan` (entitled), not "a row exists" (`billing_screen.dart:104`).
- **#6:** sign-up and password reset require at least 8 characters on the client.
- **#7:** after sign-up, show a "check your email" state, as the web does.
- **#8:** hide Sign in with Apple on Android.
- **#9:** every generate, retry and vary sends an `Idempotency-Key` (a UUID per user action, reused on the automatic retry of the same action).
- **#11:**
  - Complete an IAP purchase only after the server verifies it. On a verify failure, leave it incomplete so the store delivers it again, and log it.
  - Refuse to start a purchase until the profile has loaded (a non-empty `applicationUserName`).
- **#13:** refresh the profile (credits and plan) when the app resumes.
- **#15:** a 404 on delete removes the tile.
