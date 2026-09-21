# Retention and Deletion Policy (decision D2)

Written 2026-09-20, decided 2026-09-21. Every number here is enforced by
`0021_durable_deletion.sql` and asserted by `supabase/tests/deletion.sql`.
Changing a number means changing both, plus the customer-facing copy listed at
the bottom.

## What each deletion actually removes

| Action | Rows | Objects | Ledger | Auth user |
|---|---|---|---|---|
| Delete one generation | the row | media + thumb | kept | kept |
| Delete a persona | tombstone, then remove after training settles | owned photos + ZIP; provider LoRA tracked separately | kept | kept |
| Delete account | requested → processing → completed | owned objects + tracked provider requests, subject to approved evidence retention | **kept, anonymised** | deleted after durable closure |
| Lapse purge (the day the paid period ends) | generations + personas | their objects | kept | kept |

The ledger survives account deletion because it is financial history: refunds,
chargebacks and tax records need it. It is anonymised — `user_id` is repointed
to null with a non-identifying audit reference (`account_deletions.id`) —
rather than deleted. The delete-account dialog says so.

## Retained data decisions

Each row below is a decision, not a description of current behaviour. "Access"
is who may read it after closure; everything listed is service_role-only and
unreachable from any customer session.

| Data | Duration after closure | Purpose | Access | Deletion trigger |
|---|---|---|---|---|
| `ledger_entries` | 7 years | Financial history: refunds, chargebacks, tax | service_role; support only via an audit reference | Age, by a retention sweep — never by a customer request |
| `billing_transactions`, `billing_deliveries` | 7 years | Proof of what was charged and what was granted for it | service_role | Age |
| `provider_expenses`, `training_provider_expenses` | 7 years | Cost accounting and daily-budget history; contains no customer content | service_role | Age |
| `webhook_events` (Stripe/Apple dedupe) | 7 years | Replay protection. Deleting these would let a replayed webhook grant credits again | service_role | Age |
| `submissions` (request idempotency keys) | **deleted at finalisation** | They dedupe generation requests for an account that no longer exists; the money they anchor lives in `ledger_entries`/`billing_transactions`, which are retained | — | Finalisation |
| `moderation_events` (incl. quarantined evidence objects) | 12 months from the enforcement action | Appeals (30-day window in the acceptable-use page) and legal defence | service_role; evidence objects are never signed for a customer | The 12-month deadline, applied as an **evidence hold**: the object is `held`, not `gone`, and cleanup runs only after it expires |
| `app_errors` | 30 days (existing `purge_app_errors` cron) | Diagnostics | service_role | Age |
| Persona training photos and `persona-zips/` ZIPs | deleted with the persona or the account, no hold | They are customer content, not evidence | — | Deletion request or lapse purge |
| Provider-hosted LoRA artifacts | tracked in `provider_artifact_deletions` until `confirmed` or `unsupported` | We do not hold these bytes; fal does | service_role | A provider acknowledgement, recorded with its evidence reference |

A provider deletion request is not proof of removal. Each
`provider_artifact_deletions` row records the API or contract clause relied on,
the acknowledgement received, and any retention the provider imposes. Where a
provider offers no deletion API the row is `unsupported` and the limitation is
stated to the customer — it is never reported as deleted.

An approved legal or evidence hold is applied explicitly by setting
`storage_objects.state = 'held'` with a `retain_until`. Held evidence is never
counted as already removed, and the inventory in Task 5 reports it in its own
column.

## The grace window

- Soft-delete window: **0 days.** A delete is immediate and irreversible. The
  content disappears from the customer's view in the same transaction, its
  objects are queued for cleanup at once, and there is no undo. The UI says
  exactly that, without hedging.
- Lapse grace before purge: **0 days after `current_period_end`.** The paid
  period *is* the grace. This follows `vansen.md` ("Purge is permanent — no
  grace period beyond the paid period itself") and **replaces** the 30-day
  library grace that the shipped `purge_lapsed_libraries` cron and the current
  customer-facing copy describe. Every affected sentence is listed below and
  must change with the cron.
  - Unchanged and stated separately: **pack credits still expire 30 days after
    a lapse** (`expire_lapsed_packs`, `0008`). Credit expiry and library purge
    are now different dates and the copy must stop implying one window.
- Outbox retry budget: **12 attempts over 24 hours**, backoff 1–60 minutes with
  jitter. After the budget is exhausted the row is dead-lettered with an alert
  and kept; a stuck object is never silently dropped.

## What "deleted" means to a customer

> Deleting your account removes your library, your personas and their photos,
> and your balance, immediately and permanently — there is no undo, and we
> cannot restore it. Removing the stored files can take a few minutes to
> finish. We keep anonymised billing records for tax and chargeback purposes,
> and any moderation evidence for up to 12 months, with your identity removed.

## Copy that must match this policy

Gathered 2026-09-21. `NEEDS-CHANGE` items are fixed in Task 4 Step 4.

| Location | Current text | Verdict |
|---|---|---|
| `vansen.md:152-164` | "Purge is permanent — no grace period beyond the paid period itself" | **OK** — this is now the policy |
| `src/app/features/legal/privacy-page.html:161` | "Media on a lapsed subscription — purged after a 30-day grace period following lapse" | **NEEDS-CHANGE** → purged when the paid period ends |
| `src/app/features/settings/billing-tab/billing-tab.html:97` | "expire 30 days after, and your library is deleted after the same grace period" | **NEEDS-CHANGE** → separate the two: pack credits expire 30 days after; the library is deleted when the paid period ends |
| `src/app/features/settings/billing-tab/billing-tab.html:105` | "left to download your library or resubscribe before deletion" | **NEEDS-CHANGE** → must count down to `current_period_end`, not to a 30-day grace |
| `src/app/features/settings/cancel-flow-dialog/cancel-flow-dialog.html:52,58` | "Your library survives 30 days past the end, then it's deleted" | **NEEDS-CHANGE** → the library is deleted when the period ends; pack credits expire 30 days later |
| `src/app/features/settings/profile-tab/profile-tab.html:77` | "Library, balance, and history are wiped permanently. There is no undo." | **NEEDS-CHANGE** — "history" is wrong: anonymised billing records are kept. Replace with the sentence above |
| `src/app/features/settings/profile-tab/profile-tab.ts:84` | `confirm('… Library, balance, and history are wiped. This cannot be undone.')` | **NEEDS-CHANGE** — same correction |
| `src/app/features/legal/privacy-page.html:165` | "Moderation evidence — retained for up to 12 months" | **OK** |
| `src/app/features/legal/privacy-page.html:170` | "Billing and tax records — retained as required by law, typically up to seven (7) years" | **OK** |
| `src/app/features/legal/acceptable-use-page.html:125` | 30-day appeal window, evidence retained for the appeal | **OK** — consistent with the 12-month hold |
| `src/app/features/legal/privacy-page.html:158` | "Content — until you delete it, or until your account is deleted" | **OK** |

**Warning recorded with the decision:** moving the library purge from a 30-day
grace to the period end shortens a window that shipped copy currently promises.
Customers whose subscription lapses between this change and the copy update
would lose their library earlier than the page they read said. Task 4 Step 4
must ship the copy change in the same release as the cron change, and the lapse
warning email/banner must be sent before the period ends, not after.
