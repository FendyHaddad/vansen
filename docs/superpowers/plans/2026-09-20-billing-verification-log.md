# Billing verification log (P2 Task 8)

Manual, test-mode evidence that the fulfillment path in
`2026-09-20-release-hardening-p2-billing-fulfillment.md` behaves as designed.
This log is the record the P2 exit criteria depend on; the automated suites
prove the logic, this proves the wiring.

**Status: NOT RUN — blocked.** No staging project exists. The plan's Task 8
prerequisite is explicit: *"Deploying to a staging project is a P9 step; if no
staging project exists, stop and tell the user — do not point a test-mode
webhook at production data."* Every row below is therefore **not run**, with the
reason recorded. None of them may be marked passing from the automated suites
alone — those run against fakes and a local database, not against Stripe or
Apple.

## Prerequisites before any row can be filled

- [ ] A staging Supabase project with `0016`–`0018` applied (P9).
- [ ] `stripe-webhook` and `api` deployed to that project.
- [ ] Stripe **test-mode** keys and a test-mode webhook endpoint pointed at the
      staging `stripe-webhook` — never at `bnorhcxhvxydkgvcxjad`.
- [ ] Apple sandbox app + App Store Server Notifications v2 pointed at the
      staging `appstore-webhook`.

## Scenario matrix

| # | Scenario | Expected | Date | Actor | Observed | Evidence | Result |
|---|---|---|---|---|---|---|---|
| 1 | First subscription, launch coupon | Charged $10/$25, granted the full 1500/3750 | | | | | not run — no staging project |
| 2 | Renewal invoice | Plan bucket snaps back to the full grant | | | | | not run — no staging project |
| 3 | Renewal replay (resend the same event from the Stripe dashboard) | No second grant; spent credits unchanged | | | | | not run — no staging project |
| 4 | Pack purchase | Pack bucket rises by the catalogued amount | | | | | not run — no staging project |
| 5 | Pack replay | No second grant | | | | | not run — no staging project |
| 6 | Upgrade Studio → Pro, `when=now` | Plan bucket tops up to 3750, never drops | | | | | not run — no staging project |
| 7 | Downgrade Pro → Studio at renewal | Grant follows the new plan at the next invoice, not immediately | | | | | not run — no staging project |
| 8 | Cancellation | Status `canceled`, access until period end, no new grant | | | | | not run — no staging project |
| 9 | Out-of-order delivery (resend an old invoice after a new one) | Refused with `stale_period`, entitlement unchanged | | | | | not run — no staging project |
| 10 | Apple sandbox initial buy | One grant, keyed on the transaction id | | | | | not run — no staging project / sandbox app |
| 11 | Apple sandbox renewal replay | No second grant | | | | | not run — no staging project / sandbox app |
| 12 | Apple sandbox refund | Clawback of exactly the original amount | | | | | not run — no staging project / sandbox app |
| 13 | `/iap/verify` during a forced RPC outage | HTTP 503 `retry_later`, no partial grant, retry succeeds | | | | | not run — no staging project |
| 14 | `POST /billing/reconcile` after a pack the webhook already granted | `credited: 0`, balance unchanged | | | | | not run — no staging project |
| 15 | `POST /billing/reconcile` for a session granted by the PRE-P2 path (bare `stripe_ref`) | `credited: 0`, balance unchanged (`legacy_ledger_ref`) | | | | | not run — no staging project |

Rows 14 and 15 are additions to the plan's matrix. They cover the second
fulfillment entry point, `POST /billing/reconcile`, which is user-callable and
was found during Task 7 to be granting outside the transactional path — see
the P2 plan's Task 7 notes.

For each row, record the resulting `billing_transactions` row and the
`ledger_entries` rows it produced. A scenario that cannot be run is recorded as
**not run** with the reason, never as passing.

## Reconciliation after the matrix

```bash
npm run reconcile:billing -- --days 1
```

Expected: `Unfulfilled: 0`. A non-zero result blocks the P2 exit criteria.

| Date | Actor | Output | Result |
|---|---|---|---|
| | | | not run — no staging project |
