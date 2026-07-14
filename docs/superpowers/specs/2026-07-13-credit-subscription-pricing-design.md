# Credit-Based Subscription Pricing — Design

**Date:** 2026-07-13
**Status:** Approved pending user review
**Supersedes:** first-purchase model ($15 = $10 credits + $5/mo Studio) and USD-denominated ledger.

## Summary

Vansen moves to a pure two-tier subscription model with a credit-denominated ledger
(Higgsfield-style). Subscriptions bundle monthly credits; add-on packs top up.
Local editing tools are free per tier; AI tools and generations charge credits.
Video models are Pro-only. Every charge is computed cost-plus, so profit is
guaranteed per job by construction.

## Plans

| Plan | Price | Credits / cycle | Access |
|---|---|---|---|
| Studio | $15/mo | 1,500 | Image models, full editing suite. No video. |
| Pro | $30/mo | 3,750 | Everything + video models (Veo, Sora, Kling, Runway, Seedance). |
| Owner | internal | unlimited | Pro access. Hidden tier (migration 0007). |

- **Launch promo:** first-time subscribers pay $10 (Studio) / $25 (Pro) for the
  first 2 billing cycles (~60 days), with the **full** credit grant. Stripe coupon
  `duration_in_months: 2`; eligibility = user has never had any subscription.
  Worst-case (100% burn) still net positive: Studio +$0.41, Pro +$1.47 per cycle.
- **Non-subscribers:** browse only. Cannot generate, edit with AI tools, or buy packs.

## Credit economics

- **Unit:** 1 credit = $0.01 of Studio retail value.
- **Global charge table** (same credits for every tier):
  `credits(job) = ceil(providerCost / (1 − STUDIO_MARGIN) × 100) × batch`
  with `STUDIO_MARGIN = 0.40`.
- **Tier margins:** Studio pays an effective 40% margin. Pro gets 25% more credits
  per dollar (3,750 vs 1,500 at 2× price), so the same job costs Pro 20% less in
  dollar terms — effective 25% margin. Replaces the single `PAYG_MARGIN = 0.33`.
- **AI edit tools** keep fixed credit prices (not the formula):
  Remove Object / Generative Fill / Expand = **10 cr**, Remove Background = **5 cr**,
  Upscale = **7 cr**. Local tools (ONNX/Canvas2D suite: heal, cut out, bokeh,
  smart select, filters, transforms, etc.) are free — zero marginal cost.
- **Studio Edit save** (`POST /edits/save`) remains a $0 moderated version — 0 credits,
  Studio-gated as today.

### Rationale (from Higgsfield reverse-engineering, verified 2026-05 data)

Higgsfield Starter $15 = 200 credits ($0.075/cr), Plus $49 = 1,000 ($0.049),
Ultra $129 = 3,000 ($0.043). Their per-model margins vs provider list prices swing
from +47% (Kling on Starter) to **negative** (NB Pro image −37%, Veo 3 −11% on Plus)
— they survive on volume discounts, hard model gating (no Veo on Starter), monthly
expiry breakage, and marketing-rounded credit costs. Vansen pays list prices and has
no volume deals, so we keep formula-based cost-plus pricing (safe by construction)
and copy only the structural levers: credit denomination, tier spread, video gating,
cycle reset.

## Ledger: two buckets

| Bucket | Granted by | Reset behaviour | Spend order |
|---|---|---|---|
| `plan` | subscription renewal (`invoice.paid`) | **reset to plan grant** each cycle (no carry-forward) | spent first |
| `pack` | add-on purchases | **rolls over while subscription active**; dies 30 days after subscription lapses (same grace as library purge) | spent second |

- Spend order plan-first maximizes reset breakage while protecting purchased credits.
- Refunds (`fn_fail_job`, refund-once via `ledger_refund_once`) return credits to the
  bucket they were drawn from.
- All balances are **integer credits**.

## Add-on packs

Subscriber-only, one-time Stripe checkout. Tier rate × size bonus:

| Pack | Bonus | Studio credits | Pro credits |
|---|---|---|---|
| $10 | 0% | 1,000 | 1,250 |
| $25 | +5% | 2,625 | 3,281 |
| $50 | +8% | 5,400 | 6,750 |
| $100 | +10% | 11,000 | 13,750 |

Worst-case net margin after Stripe fees ≥ ~14% on every cell (Pro $100 pack is the
floor). Checkout screen states roll-over rules explicitly.

## Backend changes

Migration `0008_credit_plans.sql`:

- Ledger converts to integer credits with `bucket` column (`plan` | `pack`).
- RPCs: cycle reset (plan bucket → grant amount), charge (ordered spend),
  refund-once (bucket-aware), pack grant.
- `models.min_plan` column (`studio` | `pro`): all video families = `pro`.
  Kill switch (`models.enabled`) unchanged.
- Pack catalog table (price, bonus pct) — or shared-catalog constant synced via
  `npm run sync-shared`; prefer shared constant, packs rarely change.

Edge Function `api`:

- `POST /billing/subscribe` — plan checkout (Studio/Pro), applies promo coupon when
  eligible.
- `POST /billing/pack` — add-on checkout; 403 `subscription_required` without an
  active subscription.
- Generation route: 403 `pro_required` when a Studio user requests a video family
  (or any `min_plan='pro'` model).
- Moderation-before-charge, stale-job sweep, purge cron: unchanged, credit units.

`stripe-webhook`:

- `invoice.paid` → cycle reset + plan grant (sole writer, signature + dedupe +
  `stripe_ref` UNIQUE as today).
- Pack checkout completion → pack bucket grant.
- Subscription deleted/lapsed → start 30-day pack-grace countdown (reuse
  `purge_lapsed_libraries` timing).

Stripe (TEST mode): 2 subscription prices, 1 promo coupon, 4 pack prices. IDs in
Edge Function secrets (replace `STRIPE_STUDIO_PRICE_ID`).

## Frontend changes

- **Catalog** (`model-families.ts`): `userPriceUsd` → `creditCost(family, settings)`
  using the global table; `EDIT_TOOLS` gain `creditCost` (10/10/10/5), upscaler 7.
  `PAYG_MARGIN` retired; new `STUDIO_MARGIN = 0.40`, `PRO_CREDIT_RATE = 1.25`.
  Vitest drift guard + `sync-shared` regenerate + redeploy `api`.
- **Workspace**: price chips show credits ("10 cr"); top-bar balance in credits
  (plan + pack combined, tooltip splits buckets); video model cards locked with PRO
  badge for Studio users; AI tools show credit price; local tools show none.
- **Pricing page**: two plan cards + promo strip + pack table + credit calculator
  (pricing-engine rewritten for credit math: per-tier credits-per-dollar, worked
  examples per model).
- **Homepage**: hero and pricing teaser tell the two-tier story ($15 / $30, promo
  $10 / $25 for 60 days).
- **Onboarding / step-by-step guide** (`core/tour/`, `shared/tour-overlay/` — in
  flight from the notifications-and-onboarding spec): fresh signups now have no
  subscription and cannot generate, so the tour gains a plan beat:
  - `credits` step copy → explains monthly credit reset, pack roll-over, and
    automatic refunds (current copy says "top-ups" only).
  - New final step (or welcome-step variant) for non-subscribers: pick Studio or
    Pro, surfacing the 60-day promo price — CTA into the plan checkout. Subscribed
    users (and owner) never see it.
  - Left-panel/right-panel step copy stays tier-neutral; PRO-locked video models
    need no tour mention.
- **Settings → Billing**: current plan, renewal date, per-bucket balances, pack
  purchase entry point, cancel flow note ("pack credits expire 30 days after
  cancellation").

## Backoffice (vankode-backoffice repo — separate pass)

- Plan and per-bucket credit columns in user views.
- Margin dashboard reads credit ledger (credits × tier rate − provider cost).
- Promo cohort visibility (who is in the 60-day window).

## Out of scope

- Video generation itself (Phase 4b) — gating lands now, teaser stays locked.
- Annual billing, team seats.
- Real-customer migration: Stripe is TEST mode, no production subscribers; dev
  test data is wiped/re-seeded to the new plans.

## Surfaces checklist

Every place the old model leaks must change in the same rollout:

1. Homepage (hero, pricing teaser, CTAs).
2. Pricing page (plan cards, promo strip, pack table, calculator).
3. Onboarding tour + step-by-step guide (subscribe beat, credits-step copy).
4. Workspace (price chips, balance, PRO locks, AI-tool prices).
5. Settings → Billing tab (plan, buckets, packs, cancel copy).
6. Backend (migration 0008, `api` routes, `stripe-webhook`, shared catalog sync).
7. vankode-backoffice (separate repo, separate pass — plan/bucket columns, margin
   dashboard, promo cohort).

## Testing

- Vitest: credit charge table math, pack bonus table, ordered-spend/reset/refund
  RPC specs, catalog drift guard.
- Manual: promo checkout (first-time vs returning), Studio-blocked video request,
  pack purchase without subscription, cycle reset via Stripe test clock.
