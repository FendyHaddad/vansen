# Vansen MVP Phase 2 — Money (Stripe)

Date: 2026-07-07
Status: approved in brainstorming; pending user review of this document
Prerequisites: Phase 1 Foundation live (`2026-07-07-mvp-foundation-design.md`).
Environment: Stripe **test mode only** this phase (account activation pending bank
authorization — sandbox covers everything; live keys are a phase-4 flip).

## 1. Goal

Real money in: Stripe-hosted checkout for top-ups and the Studio subscription,
webhook-driven ledger credits with airtight payment integrity, Studio lifecycle with
30-day grace and automated purge, Stripe-native promo codes for launch pricing.

## 2. Decisions (from brainstorming)

1. **Hosted Stripe Checkout** (redirect), not embedded/custom — minimal PCI scope,
   promo-code box built in.
2. **Stripe-native promo codes** (coupons + promotion codes) — no custom promo tables.
   `allow_promotion_codes: true` on every session.
3. **Stripe Billing Portal** for subscription management — one "Manage Studio" button,
   no custom cancel UI.
4. **Minimum top-up $10.** Presets $10/$20/$50/$100.
5. **Launch entry price $15**: first purchase = $10 credits + $5 first Studio month.
   First-purchase presets: $15/$25/$55/$105 (credits preset + $5).
6. **Studio fee never touches the wallet.** Ledger records generation money only
   (`topup +$N` for the credits line). Renewal invoices live in the Stripe portal.
   The phase-1 stub's `studio_fee` wallet entry pattern is dead (enum value stays for
   flexibility).
7. Currency: USD everywhere.

## 3. Stripe objects

- Product **Vansen Studio** → recurring Price $5/month (created once by a setup script
  via the Stripe API; price id stored as function secret/config).
- Product **Vansen Credits** → no fixed prices; sessions pass `price_data` with a
  server-validated amount.
- One Stripe **Customer** per user, created lazily at first checkout;
  `profiles.stripe_customer_id` stores the link.

## 4. Checkout flows (`POST /billing/checkout` on the `api` gateway)

Request `{ creditsUsd?: number, studioOnly?: boolean }`, JWT-authed. Server validates
`creditsUsd ∈ {10, 20, 50, 100}` (min $10 — reject anything else).

| Situation | Session | Due today |
|---|---|---|
| No active Studio, `creditsUsd` given | `mode: subscription`: Studio $5/mo recurring + credits one-time | creditsUsd + $5 |
| Active Studio, `creditsUsd` given | `mode: payment`: credits one-time | creditsUsd |
| `studioOnly: true` (lapsed reactivation) | `mode: subscription`: Studio only | $5 |

Every session: `allow_promotion_codes: true`, `metadata: { user_id, credits_usd }`,
`customer` attached, success URL `/app?checkout=success`, cancel `/app?checkout=canceled`.

`POST /billing/portal` → Billing Portal session URL.
`POST /billing/reconcile` → self-heal (see §6).

## 5. Webhook function `stripe-webhook`

Separate Edge Function (no JWT; Stripe signature is the trust anchor).

1. Verify `stripe-signature` against the webhook signing secret. Invalid → 400,
   nothing processed.
2. Dedupe: insert event id into `webhook_events (id pk, type, received_at)` with
   `on conflict do nothing`; already-seen → 200 immediately.
3. Handle:

| Event | Action |
|---|---|
| `checkout.session.completed` (and `checkout.session.async_payment_succeeded`) | Only if `payment_status = 'paid'`: cross-check `metadata.credits_usd` against `amount_subtotal`; write ledger `topup +credits_usd` with `stripe_ref = session.id`; if cart had the subscription, upsert `subscriptions` (plan studio, active, period end) |
| `invoice.paid` | Update `subscriptions.current_period_end` |
| `customer.subscription.updated` | Mirror status/`cancel_at_period_end` |
| `customer.subscription.deleted` | Status → `expired` (grace clock = `current_period_end`) |
| `invoice.payment_failed` | Log only (Stripe dunning owns retries) |
| anything else | 200, ignore |

4. Return 200 **only after** DB writes commit; failures → 500 so Stripe retries
   (~3 days of automatic retries).

## 6. Payment integrity (explicit requirement: airtight both directions)

**No credit without payment:**
- Ledger `topup` writes exist ONLY in the webhook handler.
- Signature-gated; `payment_status='paid'` gated; amount cross-checked against
  Stripe's `amount_subtotal` (metadata is server-set at session creation).
- **DB guarantee:** `ledger_entries.stripe_ref` UNIQUE — one session, one credit, ever.
  Replays/bugs bounce off the constraint.
- Event-id dedupe on top.

**No payment without credit:**
- 200-after-commit + Stripe's multi-day retry loop → outages self-heal.
- Success page polls `/profile` briefly before declaring credits added.
- `POST /billing/reconcile`: lists the customer's paid checkout sessions from Stripe,
  credits any session id missing from `ledger_entries.stripe_ref`. Idempotent by the
  unique constraint. Surfaced as "Didn't receive your credits?" in Billing.
- Full audit join always possible: Stripe sessions × ledger stripe_refs.

## 7. Studio lifecycle

States: **Paying** → (portal cancel) **Canceled** (works until period end; UI warns
"ends {date}; library deleted 30 days after") → **Lapsed** (30-day grace: banner with
days left; generation still allowed — balance survives, library is what's at stake) →
**Purged** (day 31: daily `pg_cron` job deletes `generations` rows where subscription
status in ('canceled','expired') and `current_period_end < now() − 30 days`; ledger is
never purged; phase 3 extends the sweep to Storage objects).

Safety rules:
- Failed renewal ≠ instant lapse — Stripe dunning retries first; terminal failure
  arrives as `subscription.deleted`.
- Reactivation during grace ($5 studio-only checkout) → active, purge clock cleared.
- **Account deletion cancels the Stripe subscription first** (`subscriptions.cancel`)
  then wipes — no charges to dead accounts (closes the phase-1 audit item).

## 8. Schema (migration 0003)

```sql
alter table public.profiles add column stripe_customer_id text unique;
alter table public.ledger_entries add column stripe_ref text unique;
create table public.webhook_events (
  id text primary key,
  type text not null,
  received_at timestamptz not null default now()
);
alter table public.webhook_events enable row level security;  -- deny-all like the rest
-- pg_cron daily purge job (SQL delete per §7)
```

## 9. Frontend

- Billing tab: top-up preset buttons → checkout redirect; "Manage Studio" → portal;
  reconcile button; canceled/lapsed warnings per §7.
- Workspace/editor top-up nudges → checkout (phase-2 placeholder copy removed).
- `/app?checkout=success` → poll profile (~5s) → "Credits added" banner;
  `canceled` → quiet notice.
- Pricing page: "Start from $15 — $10 balance + first month of Studio"; chips
  $15/$25/$55/$105; estimates recomputed.
- Lapsed-grace banner in workspace shell.

## 10. Config + user actions (test mode)

- Function secrets (user pastes in Supabase dashboard → Edge Functions → Secrets):
  `STRIPE_SECRET_KEY` (test), `STRIPE_WEBHOOK_SECRET`, `STRIPE_STUDIO_PRICE_ID`
  (from setup script output).
- User registers the webhook endpoint in Stripe dashboard
  (`https://bnorhcxhvxydkgvcxjad.supabase.co/functions/v1/stripe-webhook`,
  events per §5) and copies the signing secret.
- Promo code: user creates coupon + promotion code in dashboard when ready
  (e.g. LAUNCH30); no code changes needed.
- Stripe npm SDK (`npm:stripe`) inside Edge Functions; API version pinned.

## 11. Verification

- Unit: preset validation, session-type selection logic, webhook handler with mocked
  events (signature, dedupe, paid-gate, amount mismatch rejection).
- Live test-mode E2E in the preview browser: first purchase $15 with 4242 card →
  webhook → ledger `topup +10` + subscriptions active → balance on screen; later
  top-up $20; decline card path; duplicate webhook replay → single credit;
  reconcile drill (delete ledger row in SQL, run reconcile, row returns);
  portal cancel → status canceled; simulate period end (Stripe test clocks or manual
  SQL) → grace banner; purge job dry-run; account deletion cancels subscription.

## 12. Out of scope

Live keys/go-live (phase 4). Bonus-credit promos (option B — future). Refund handling
UI (`refund` ledger type exists; manual via Stripe dashboard for now, webhook may log).
Storage purge (phase 3). Custom SMTP, CAPTCHA, email confirmations (phase 4).
