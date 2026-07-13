# Owner tier, Pro lock pass, backoffice error notifications & plan assignment — design

Date: 2026-07-13
Status: approved in discussion; spec pending user review

## Goal

Pre-live hardening pass. Four workstreams:

1. **Plan rename** — subscription plans become `studio | pro | owner` (was `studio | studio_pro`).
2. **Owner tier** — hidden internal plan: all Pro benefits + unlimited credits, usage fully
   tracked in the ledger. Never shown in public UI, pricing, or plans pages.
3. **Pro lock pass** — Pro-preview editing tools locked behind `pro`/`owner`; everyone else
   sees the existing locked-teaser affordance.
4. **Backoffice** — app_errors surface as notifications; backoffice can grant/revoke the
   owner plan and sees per-owner usage.

Explicitly out of scope: Stripe live mode, video generation (Phase 4b), Phase 4 image
tools (AI Sharpen / Denoise / Colorize).

## Decisions (from brainstorming)

- Unlimited credits = **plan bypass** in `fn_charge_and_generate`: owner skips the
  `insufficient_balance` check but the charge ledger row is still written. Ledger remains
  the single source of truth; an owner's balance goes negative by design. (Rejected: fake
  giant top-up — pollutes economics; separate usage table — splits tracking.)
- First owner grant: `fendyhaddad@google.com` (user-confirmed literal address; account
  does not exist yet, so grants must work pre-signup).
- Lock pass proceeds now even though `pro` is not purchasable — only `owner` (and future
  `pro`) users get Pro tools until the Pro tier launches.
- Error watching = notification-panel events in backoffice (no email/push alerting).
- Owner assignment UI = row action on the backoffice vansen users page.

## A. Vansen database (migration `0007_owner_tier.sql`, applied via MCP)

1. **Plan rename + owner**: drop/recreate `subscriptions.plan` check as
   `plan in ('studio','pro','owner')`. Data migration `update … set plan='pro' where
   plan='studio_pro'` (no live rows today; belt-and-braces).
2. **`plan_grants` table** — pre-provisioning by email:
   ```sql
   create table public.plan_grants (
     email      text primary key,          -- stored lowercase
     plan       text not null check (plan in ('studio','pro','owner')),
     granted_by text not null,             -- backoffice admin email or 'seed'
     created_at timestamptz not null default now()
   );
   ```
   RLS enabled, deny-all (no policies). Service-role access only.
3. **`handle_new_user()` trigger update**: after the profile insert, look up
   `plan_grants` by `lower(new.email)`; if found, insert a `subscriptions` row
   (`plan` = grant, `status='active'`, `current_period_end = null` → never expires,
   `stripe_subscription_id = null`).
4. **`fn_charge_and_generate` owner bypass**: before the balance check, look up the
   user's subscription; when `plan='owner' and status='active'` skip the
   `insufficient_balance` raise. Charge ledger insert unchanged — usage always recorded.
5. **Backoffice RPCs** (SECURITY DEFINER, `set search_path=public`, execute revoked from
   public/anon/authenticated, granted to service_role only):
   - `backoffice_set_plan(p_email text, p_plan text)` — `p_plan` null ⇒ revoke: delete
     grant + delete any non-Stripe subscription row for that user. Non-null ⇒ upsert
     `plan_grants` and, if the user already exists, upsert `subscriptions`
     (`status='active'`, `current_period_end=null`). Rejects plans outside the enum.
     Refuses to overwrite a Stripe-backed subscription (`stripe_subscription_id` not
     null) — returns an error marker instead.
   - `backoffice_owner_usage()` — jsonb: per owner user (email, display name), total
     generation count, `sum(price_usd)` spend-equivalent, last-30-day daily series,
     current negative balance.
6. **`backoffice_summary()` update**: `recent` gains last-5 `app_errors`
   (`type='error'`, title = `code · route`) so the existing backoffice notification
   poller surfaces them with zero backend change.
7. **Seed**: `insert into plan_grants values ('fendyhaddad@google.com','owner','seed')`.

## B. Vansen API (`supabase/functions/api`)

- `/billing/checkout`: when the caller's subscription plan is `owner`, refuse
  subscription-bearing checkout (400 `owner_plan`) — owners never pay; top-ups are
  pointless and would confuse the ledger.
- `/profile` response unchanged in shape — `subscription.plan` now carries
  `studio|pro|owner`.
- Enum master `src/app/core/enums.ts`: `SubscriptionPlan.StudioPro: 'studio_pro'` →
  `SubscriptionPlan.Pro: 'pro'`, add `SubscriptionPlan.Owner: 'owner'`; run
  `npm run sync-shared`; update `enums.spec.ts`; redeploy `api`.

## C. Vansen frontend

- **`ProfileStore`**: add `proActive` computed — plan ∈ (`pro`,`owner`) and not expired
  (same period-end logic as `studioActive`). `studioActive` already true for owner
  (null period end).
- **Balance UI**: when plan is `owner`, the credit chip shows "Unlimited" instead of the
  dollar balance (workspace top bar + settings billing tab). Usage/ledger tab keeps
  showing every charge row — tracking stays visible. Owner label never appears anywhere
  else; plans/pricing pages untouched.
- **Lock pass** (`right-panel` + tool wiring): gated by `proActive` —
  enhance, levels, clone, retouch, perspective, Cut Out, Bokeh, Upscale 2×, Smart
  Select, Magic Erase, and AI edit tools (`edit-remove|edit-fill|edit-expand|edit-bg`).
  Non-pro users get the existing lock affordance (lock badge + disabled control,
  per the panel's designed lock pass). Studio keeps: rotate/flip/straighten, filters,
  heal, dehaze, portrait smooth, `POST /edits/save`.
- Guard rail: AI edit tool invocation also checks `proActive` client-side before POST;
  server keeps charging path unchanged (kill-switch rows in `models` remain the
  server-side control).

## D. Backoffice (vankode-backoffice repo)

- **Backend** (`VansenAdminService` / `VansenAdminController`, existing service-key
  transport):
  - `POST /api/vansen/plan` body `{email, plan|null}` → calls `backoffice_set_plan`.
    Admin-gated like existing vansen routes. Validates email shape + plan enum before
    the RPC call.
  - `GET /api/vansen/owner-usage` → `backoffice_owner_usage`.
- **Frontend**:
  - Vansen users page: per-row action — "Grant owner" / "Revoke owner" with confirm
    dialog; owner badge on rows whose plan is `owner`. Plan choice fixed to `owner` for
    now (API accepts any plan for future use).
  - New "Owner usage" card/section (economics page): per-owner counts, spend-equivalent,
    daily series.
  - Notification panel: `type==='error'` events styled distinct (red icon). Data already
    flows via `recent`.

## E. Auth hardening

- Enable Supabase leaked-password protection (HaveIBeenPwned) — dashboard/API toggle,
  no code.

## Error handling

- `backoffice_set_plan` returns explicit jsonb `{ok, error?}`; backoffice surfaces the
  error string (e.g. Stripe-backed subscription refusal) in a toast.
- Owner bypass never masks other charge failures — moderation gate, kill switch, and
  refund-once logic untouched.
- `handle_new_user` grant lookup is best-effort inside the existing trigger; a grant
  failure must not block signup (wrap in exception guard).

## Testing

- Vitest: enums spec updated for new plan values; shared-sync drift guard keeps passing.
- SQL verified via MCP after migration: constraint accepts `pro`/`owner`, rejects
  `studio_pro`; charge fn bypass exercised with a seeded owner user (balance 0 → charge
  succeeds, ledger row present, balance negative).
- Frontend: `ng test` for ProfileStore `proActive`; manual browser pass for lock
  affordances + Unlimited chip.
- Backoffice: existing validation-test pattern (`VansenAdminValidationTest`) extended
  for the new endpoint; manual browser pass for row action + notifications.
