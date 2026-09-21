# Release Hardening P2 — Transactional Billing Fulfillment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every credit grant and entitlement change from Stripe and Apple exactly-once under concurrency and process failure, so a retried webhook can never reset a customer's spent credits and a failed grant can never be skipped forever.

**Architecture:** One `fn_apply_fulfillment` RPC owns the whole money transaction: it takes an advisory lock on the user, short-circuits on an already-applied **business transaction** (invoice id, Apple transaction id), writes the ledger movement and the entitlement mirror together, records the applied transaction, and returns the stored result. `webhook_events` stops being the idempotency anchor and becomes what its name says — a delivery marker. The `iaptx:` marker, whose failure mode is "marker written, grant lost, retry skipped", is deleted entirely. TypeScript keeps the Stripe/Apple-shaped decisions (which plan, which grant, which mirror fields) and hands the RPC a finished patch.

**Tech Stack:** Postgres (plpgsql, advisory locks), Deno, `jsr:@supabase/supabase-js@2`, `npm:stripe@17`, Apple App Store Server Library.

**Source spec:** `docs/superpowers/plans/2026-09-17-release-readiness-review-and-implementation-plan.md` — this plan implements **T03**, closing **R02**, the server half of **R21**, and decision **D1**. It is the backend prerequisite for the mobile plan's **MT-01**.

## Global Constraints

- **Never commit, branch, or push.** Every task ends with "user commits". No `git commit` steps anywhere in this plan.
- **No nested if statements** in TypeScript. Guard clauses and early returns only.
- **Never put Stripe or Apple keys in the repo.** Secrets live in Supabase Edge Function secrets. Tests never reach a real provider.
- **Stripe is in TEST MODE.** Every verification step in this plan runs against test keys. Live keys are switched on in P9, not here.
- **Never trust a client-provided grant value.** Credits come from the catalog (`PLAN_CREDITS`, `packCredits`) keyed by the verified product or price, never from a request body or from Stripe metadata alone.
- **Migration numbering:** the highest file on disk is `0016_video.sql` (present on disk; deployed state **unverified**); P1 adds `0017_upload_registry.sql`. This plan adds `0018_*`. Confirm the deployed inventory (P1 Task 6 Step 1) before adding it, and never renumber an applied migration. `0008_age_gate.sql` and `0008_credit_plans.sql` share a prefix — leave both alone.
- **New RPCs are service_role-only:** `revoke execute … from public, anon, authenticated; grant execute … to service_role;`
- **Never repair historical balances automatically.** The reconciliation report in Task 7 is read-only. Any correction is a separate, owner-approved action.
- **Tests:** Edge → `cd supabase/functions && deno test --allow-all _shared api stripe-webhook appstore-webhook`. SQL → against a **local** Supabase stack only (Task 1). Angular → `npm test -- --watch=false`.
- **Execution baseline:** run the current focused suite after this plan's prerequisites and record actual counts; predicted totals are not acceptance criteria.
- **No deploys.** No `supabase functions deploy`, no `apply_migration` against `bnorhcxhvxydkgvcxjad`.

## Decision implemented here (D1)

`vansen.md` §5 records the promotion as **"first 2 cycles $10 / $25 with full credit grant."** The current `cycleGrant` in `stripe-webhook/index.ts:59–65` scales the grant down by the discount ratio, so a launch-coupon Studio invoice grants 1000 credits instead of 1500. **This plan changes the code to match the spec**, not the other way round. Task 4 implements it with a test per case: launch coupon, proration, no discount, $0 invoice.

---

## File Structure

**New:**
- `supabase/migrations/0018_billing_fulfillment.sql` — `billing_transactions` table + `fn_apply_fulfillment` + `fn_paid_unfulfilled` reconciliation view.
- `supabase/tests/billing_transactions.sql` — SQL integration proof (replay, concurrency, ordering, failure injection). Runs against a local stack only.
- `supabase/functions/_shared/testing/fakes.ts` — the shared `FakeDb`/`FakeStorage` home (moved here from `api/testing/fakes.ts` in Task 1 so the webhook tests can use it too).
- `supabase/functions/_shared/billing-fulfillment.ts` + `_test.ts` — `applyFulfillment`, `cycleGrant`, `isDuplicateKey`, `stripeEntitlement`, `appleEntitlement`.
- `supabase/functions/stripe-webhook/handler.ts` + `handler_test.ts` — `createStripeWebhook(deps)`.
- `supabase/functions/appstore-webhook/handler.ts` + `handler_test.ts` — `createAppstoreWebhook(deps)`.
- `supabase/functions/api/services/billing-lane_test.ts` — lane enforcement route tests.
- `scripts/billing-reconcile.mjs` — read-only paid-unfulfilled report.

**Modified:**
- `supabase/functions/_shared/iap-grants.ts` — `applyIapTransaction` routes through the RPC; the `iaptx:` marker is removed.
- `supabase/functions/api/testing/fakes.ts` — re-exports the moved fakes, keeps `testDeps`.
- `supabase/functions/api/app.ts` — `/iap/verify` tri-state response; lane enforcement on `/billing/subscribe` and `/billing/pack`.
- `supabase/functions/stripe-webhook/index.ts`, `supabase/functions/appstore-webhook/index.ts` — composition only.

---

## Task 1: Move the shared fakes and add a local SQL test harness

**Files:**
- Create: `supabase/functions/_shared/testing/fakes.ts`
- Modify: `supabase/functions/api/testing/fakes.ts`
- Create: `supabase/tests/billing_transactions.sql` (skeleton + first assertion)

**Interfaces:**
- Consumes: `FakeDb`, `FakeStorage`, `TEST_USER`, `OTHER_USER` from P1 Task 1.
- Produces: the same symbols exported from `_shared/testing/fakes.ts`. `api/testing/fakes.ts` re-exports them unchanged, so every P1 test keeps compiling with no edit.

**Blocking dependency — read this before starting.** Tasks 1 and 2 need a **local** Supabase stack (`supabase start`) to run the SQL tests. If Docker or the Supabase CLI is unavailable on this machine, stop and tell the user: the money path is the one place where a fake database is not sufficient proof, and this plan does not substitute a TypeScript approximation for it. Every other task in this plan runs without it.

- [x] **Step 1: Confirm the local stack is available**

```bash
cd /Users/user/IdeaProjects/vansen && supabase start && supabase status
```

Expected: a running stack with a printed `DB URL` of the form `postgresql://postgres:postgres@127.0.0.1:54322/postgres`. Export it for the rest of this plan:

```bash
export VANSEN_LOCAL_DB="postgresql://postgres:postgres@127.0.0.1:54322/postgres"
```

If this fails, stop and report. Do not point any command in this plan at `bnorhcxhvxydkgvcxjad`.

- [x] **Step 2: Move the fakes**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && mkdir -p _shared/testing && git mv api/testing/fakes.ts _shared/testing/fakes.ts
```

In `_shared/testing/fakes.ts`, delete the `testDeps`, `fakeAdapter` and `fakeModeration` definitions and their imports of `../app.ts` and `../_shared/providers/types.ts` — those are api-specific and move back in the next step. Keep `Row`, `FakeError`, `FakeResult`, `TEST_USER`, `OTHER_USER`, `FakeQuery`, `StoredObject`, `FakeStorage` and `FakeDb`.

- [x] **Step 3: Re-create `api/testing/fakes.ts` as a thin layer**

```ts
// api-specific test doubles. The database/storage fakes live in _shared so the
// webhook functions can use the same ones.
export { FakeDb, FakeStorage, OTHER_USER, TEST_USER } from '../_shared/testing/fakes.ts';
export type { FakeError, FakeResult, Row, StoredObject } from '../_shared/testing/fakes.ts';

import { FakeDb, TEST_USER } from '../_shared/testing/fakes.ts';
import type { ApiDeps } from '../app.ts';
import type { CheckResult, ProviderAdapter, SubmitCtx } from '../_shared/providers/types.ts';

// ... fakeAdapter, fakeModeration and testDeps, exactly as P1 Task 2 Step 5 wrote them ...
```

- [x] **Step 4: Run the whole edge suite to prove the move changed nothing**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno check api/index.ts api/app.ts && deno test --allow-all _shared api
```

Expected: `105 passed | 0 failed` — the same count as the end of P1.

- [x] **Step 5: Write the failing SQL integration test**

Create `supabase/tests/billing_transactions.sql`:

```sql
-- Integration proof for the billing fulfillment transaction.
-- LOCAL DATABASE ONLY. Every statement runs inside one transaction that is
-- rolled back at the end, so this file never leaves rows behind — but it
-- creates and destroys users, so it must never be pointed at production.
begin;

do $$
declare
  v_user uuid := '33333333-3333-4333-8333-333333333333';
  v_first jsonb; v_replay jsonb; v_plan int;
begin
  insert into auth.users (id, email) values (v_user, 'sqltest@example.com')
    on conflict (id) do nothing;
  insert into public.profiles (id, birth_date) values (v_user, '1990-01-01')
    on conflict (id) do nothing;

  -- 1. First application of an invoice grants the full plan bucket.
  v_first := public.fn_apply_fulfillment(
    p_source      => 'stripe',
    p_txn_id      => 'in_test_1',
    p_user        => v_user,
    p_kind        => 'subscription_grant',
    p_plan        => 'studio',
    p_credits     => 1500,
    p_period_end  => now() + interval '30 days',
    p_event_at    => now(),
    p_entitlement => jsonb_build_object('plan','studio','status','active',
                       'current_period_end', (now() + interval '30 days')::text,
                       'stripe_subscription_id','sub_test_1'),
    p_never_lower => false,
    p_clear_pending => false
  );
  assert (v_first->>'applied')::boolean, 'first application must apply';
  select bal.plan_credits into v_plan from public.fn_balances(v_user) bal;
  assert v_plan = 1500, format('expected 1500 plan credits, got %s', v_plan);

  -- 2. The customer spends, then the SAME invoice is delivered again.
  insert into public.ledger_entries (user_id, type, bucket, amount_credits, note)
    values (v_user, 'generate', 'plan', -400, 'sql test spend');
  v_replay := public.fn_apply_fulfillment(
    p_source => 'stripe', p_txn_id => 'in_test_1', p_user => v_user,
    p_kind => 'subscription_grant', p_plan => 'studio', p_credits => 1500,
    p_period_end => now() + interval '30 days', p_event_at => now(),
    p_entitlement => null, p_never_lower => false, p_clear_pending => false
  );
  assert not (v_replay->>'applied')::boolean, 'replay must not apply';
  assert (v_replay->>'replay')::boolean, 'replay must be flagged';
  select bal.plan_credits into v_plan from public.fn_balances(v_user) bal;
  assert v_plan = 1100, format('replay reset spent credits: expected 1100, got %s', v_plan);
end $$;

rollback;
```

- [x] **Step 6: Run it to verify it fails**

```bash
cd /Users/user/IdeaProjects/vansen && psql "$VANSEN_LOCAL_DB" -v ON_ERROR_STOP=1 -f supabase/tests/billing_transactions.sql
```

Expected: FAIL — `ERROR: function public.fn_apply_fulfillment(...) does not exist`. Task 2 creates it. User commits the move and the failing test.

---

## Task 2: The fulfillment transaction

**Files:**
- Create: `supabase/migrations/0018_billing_fulfillment.sql`
- Modify: `supabase/tests/billing_transactions.sql` (add the remaining cases)

**Interfaces:**
- Produces:
  ```sql
  public.billing_transactions (source, business_txn_id) unique
  public.fn_apply_fulfillment(
    p_source text, p_txn_id text, p_user uuid, p_kind text,
    p_plan text, p_credits int, p_period_end timestamptz,
    p_event_at timestamptz, p_entitlement jsonb,
    p_never_lower boolean, p_clear_pending boolean
  ) returns jsonb
  ```
  Return shape: `{applied: bool, replay: bool, reason: text|null, credits: {plan:int, pack:int}, entitlement: text|null}`.

- [x] **Step 1: Write the migration**

Create `supabase/migrations/0018_billing_fulfillment.sql`:

```sql
-- 0018: transactional billing fulfillment.
--
-- Before this migration, "exactly once" rested on public.webhook_events, whose
-- row is deleted by the webhooks' own catch block so a retry can reprocess.
-- fn_grant_pack survives that (stripe_ref UNIQUE) but fn_cycle_reset does not:
-- it is a snap-to-grant with no ref, so a reprocessed invoice resets the plan
-- bucket to the grant and silently returns credits the customer already spent.
--
-- The anchor moves to the BUSINESS transaction — the Stripe invoice/session id,
-- the Apple transaction id — which is stable across event deliveries, and the
-- whole money effect (ledger movement + entitlement mirror + applied marker)
-- commits or rolls back together.
-- (written 2026-09-20; apply AFTER 0016_video.sql and 0017_upload_registry.sql)

create table public.billing_transactions (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('stripe', 'apple')),
  business_txn_id text not null,
  user_id uuid not null references public.profiles on delete cascade,
  kind text not null check (kind in ('subscription_grant', 'pack_grant', 'clawback')),
  plan text,
  credits int not null default 0,
  period_end timestamptz,
  event_at timestamptz not null,
  result jsonb not null,
  applied_at timestamptz not null default now(),
  unique (source, business_txn_id)
);

create table public.billing_deliveries (
  source text not null, event_id text not null, business_txn_id text not null,
  user_id uuid not null, verified_at timestamptz not null default now(),
  attempts int not null default 0, last_error text,
  next_attempt_at timestamptz not null default now(), resolved_at timestamptz,
  primary key (source,event_id)
);
alter table public.billing_deliveries enable row level security;

create index billing_transactions_user_idx
  on public.billing_transactions (user_id, applied_at desc);

alter table public.billing_transactions enable row level security;

-- One transaction: lock, replay-check, validate ordering, move credits, mirror
-- entitlement, record the applied transaction. Callers pass a finished
-- entitlement patch so the Stripe/Apple-shaped decisions stay in TypeScript.
create or replace function public.fn_apply_fulfillment(
  p_source text,
  p_txn_id text,
  p_user uuid,
  p_kind text,
  p_plan text,
  p_credits int,
  p_period_end timestamptz,
  p_event_at timestamptz,
  p_entitlement jsonb default null,
  p_never_lower boolean default false,
  p_clear_pending boolean default false
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_stored jsonb;
  v_plan_balance int;
  v_delta int;
  v_newer timestamptz;
  v_result jsonb;
  v_ref text := p_source || ':' || p_txn_id;
  v_subscription public.subscriptions%rowtype;
begin
  -- Serialize everything this user's money does. fn_charge_and_generate takes
  -- the same lock, so a grant can never interleave with a spend.
  perform pg_advisory_xact_lock(hashtext(p_user::text));

  select result into v_stored
    from public.billing_transactions
    where source = p_source and business_txn_id = p_txn_id;
  if v_stored is not null then
    return v_stored || jsonb_build_object('applied', false, 'replay', true);
  end if;

  -- Ordering guard: a late delivery of an older period must not pull a live
  -- entitlement backwards or re-grant an expired cycle.
  select s.current_period_end into v_newer from public.subscriptions s
    where p_kind = 'subscription_grant' and p_period_end is not null
      and s.user_id = p_user and s.current_period_end > p_period_end;
  if v_newer is not null then
      v_result := jsonb_build_object(
        'applied', false, 'replay', false, 'reason', 'stale_period',
        'credits', public.fn_credits_json(p_user), 'entitlement', null
      );
      insert into public.billing_transactions
        (source, business_txn_id, user_id, kind, plan, credits, period_end, event_at, result)
      values (p_source, p_txn_id, p_user, p_kind, p_plan, 0, p_period_end, p_event_at, v_result);
      return v_result;
  end if;

  if p_kind = 'subscription_grant' then
    select bal.plan_credits into v_plan_balance from public.fn_balances(p_user) bal;
    v_delta := p_credits - v_plan_balance;
    -- A mid-cycle upgrade tops the bucket up to the new plan; it never takes
    -- credits away from someone who just paid more money.
    v_delta := case when p_never_lower then greatest(v_delta, 0) else v_delta end;
  end if;
  if p_kind = 'subscription_grant' and v_delta <> 0 then
      insert into public.ledger_entries
        (user_id, type, bucket, amount_credits, note, stripe_ref)
      values (p_user, 'cycle_reset', 'plan', v_delta, 'Cycle renewal grant', v_ref);
  end if;

  if p_kind = 'pack_grant' then
    insert into public.ledger_entries
      (user_id, type, bucket, amount_credits, note, stripe_ref)
    values (p_user, 'pack_purchase', 'pack', p_credits, 'Credit pack', v_ref);
  end if;

  if p_kind = 'clawback' then
    insert into public.ledger_entries
      (user_id, type, bucket, amount_credits, note, stripe_ref)
    values (p_user, 'pack_expiry', 'pack', -p_credits, 'Refund clawback', v_ref);
  end if;

  select * into v_subscription from public.subscriptions where user_id = p_user;
  if p_entitlement is not null then
    insert into public.subscriptions (
      user_id, plan, status, current_period_end, stripe_subscription_id,
      iap_original_transaction_id, cancel_reason, updated_at
    ) values (
      p_user,
      coalesce(p_entitlement->>'plan', v_subscription.plan, p_plan),
      coalesce(p_entitlement->>'status', v_subscription.status),
      coalesce((p_entitlement->>'current_period_end')::timestamptz, v_subscription.current_period_end),
      coalesce(p_entitlement->>'stripe_subscription_id', v_subscription.stripe_subscription_id),
      coalesce(p_entitlement->>'iap_original_transaction_id', v_subscription.iap_original_transaction_id),
      p_entitlement->>'cancel_reason', now()
    )
    on conflict (user_id) do update set
      plan = excluded.plan, status = excluded.status,
      current_period_end = excluded.current_period_end,
      stripe_subscription_id = excluded.stripe_subscription_id,
      iap_original_transaction_id = excluded.iap_original_transaction_id,
      cancel_reason = excluded.cancel_reason,
      pending_plan = case when p_clear_pending then null else public.subscriptions.pending_plan end,
      pending_at = case when p_clear_pending then null else public.subscriptions.pending_at end,
      updated_at = now();
  end if;

  v_result := jsonb_build_object(
    'applied', true, 'replay', false, 'reason', null,
    'credits', public.fn_credits_json(p_user),
    'entitlement', p_plan,
    'ledgerDelta', case when p_kind = 'subscription_grant' then coalesce(v_delta, 0) else p_credits end
  );

  insert into public.billing_transactions
    (source, business_txn_id, user_id, kind, plan, credits, period_end, event_at, result)
  values (p_source, p_txn_id, p_user, p_kind, p_plan, coalesce(p_credits, 0), p_period_end, p_event_at, v_result);

  return v_result;
end $$;

-- Small helper so the result shape is written once.
create or replace function public.fn_credits_json(p_user uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('plan', bal.plan_credits, 'pack', bal.pack_credits)
  from public.fn_balances(p_user) bal;
$$;

-- Read-only reconciliation: applied business transactions whose ledger effect
-- is missing, and ledger grants with no applied transaction. Never repairs.
create or replace function public.fn_paid_unfulfilled(p_since timestamptz)
returns table (source text, business_txn_id text, user_id uuid, kind text, credits int, applied_at timestamptz)
language sql stable security definer set search_path = public as $$
  select t.source, t.business_txn_id, t.user_id, t.kind, t.credits, t.applied_at
  from public.billing_transactions t
  where t.applied_at >= p_since
    and (t.result->>'applied')::boolean
    and t.kind in ('subscription_grant', 'pack_grant')
    and abs(coalesce((t.result->>'ledgerDelta')::int, 0)) > 0
    and not exists (
      select 1 from public.ledger_entries l
      where l.stripe_ref = t.source || ':' || t.business_txn_id
    )
  union all
  select distinct d.source,d.business_txn_id,d.user_id,'pending'::text,0,d.verified_at
  from public.billing_deliveries d
  where d.verified_at >= p_since and d.resolved_at is null and d.next_attempt_at <= now()
    and not exists (select 1 from public.billing_transactions t
      where t.source=d.source and t.business_txn_id=d.business_txn_id);
$$;

revoke execute on function public.fn_apply_fulfillment(
  text, text, uuid, text, text, int, timestamptz, timestamptz, jsonb, boolean, boolean
) from public, anon, authenticated;
grant execute on function public.fn_apply_fulfillment(
  text, text, uuid, text, text, int, timestamptz, timestamptz, jsonb, boolean, boolean
) to service_role;

revoke execute on function public.fn_credits_json(uuid) from public, anon, authenticated;
grant execute on function public.fn_credits_json(uuid) to service_role;

revoke execute on function public.fn_paid_unfulfilled(timestamptz) from public, anon, authenticated;
grant execute on function public.fn_paid_unfulfilled(timestamptz) to service_role;
```

Note the `fn_credits_json` helper is referenced above its own definition. That is fine — plpgsql resolves function calls at execution time, and both objects exist by the end of the migration.

- [x] **Step 1a: Persist delivery attempts separately from atomic money effects**

Add `billing_deliveries(source,event_id,business_txn_id,user_id,verified_at,attempts,last_error,next_attempt_at,resolved_at)`, unique `(source,event_id)`, service-only RLS. Insert/update this verified receipt inbox BEFORE invoking fulfillment; its existence never suppresses a retry. Catch failures outside the money transaction, increment attempts and record a safe code; acknowledge only after the effect or a verified rejection is durable. A transaction rollback must leave a retryable inbox row, never a committed applied marker.

`fn_paid_unfulfilled(p_since timestamptz)` must UNION unresolved verified deliveries overdue for processing with applied transactions whose nonzero `result.ledgerDelta` lacks a ledger entry. Use the same six return columns shown above, reporting `verified_at` in the final timestamp position for inbox rows. Zero-delta renewals and stale/rejected events are not missing grants. Retain economic transaction IDs for the financial retention period in D2; retain diagnostic `webhook_events` for 30 days, then prune by a named service-only schedule without deleting business idempotency anchors.

Add SQL/route regressions before implementing:
- First Apple purchase supplies generated `subscriptions.id/created_at`; revoke a subscription without NULL plan failure.
- Fail ledger insert, entitlement write, and marker insert independently using a local test trigger that raises an exception; each rolls back all three effects. Remove the trigger and replay twice: one grant.
- Seed the old `iaptx:<transactionId>` marker WITHOUT a grant: the new path still grants once.
- Spend credits after a grant, replay the invoice: balance stays spent.
- Valid zero-dollar discounted create/renewal receives the full D1 grant; unrelated zero-dollar invoice does not.
- A valid zero-delta reset does not trigger `fn_paid_unfulfilled(now() - interval '1 day')`; a failed verified delivery does.

- [x] **Step 2: Apply it locally and run the first two assertions**

```bash
cd /Users/user/IdeaProjects/vansen && psql "$VANSEN_LOCAL_DB" -v ON_ERROR_STOP=1 -f supabase/migrations/0018_billing_fulfillment.sql && psql "$VANSEN_LOCAL_DB" -v ON_ERROR_STOP=1 -f supabase/tests/billing_transactions.sql
```

Expected: `CREATE TABLE` / `CREATE FUNCTION` lines, then `DO` and `ROLLBACK` with no assertion failure.

- [x] **Step 3: Add the remaining SQL cases**

Insert these `do $$ … $$;` blocks into `supabase/tests/billing_transactions.sql` before the closing `rollback;`, each with its own synthetic user id:

```sql
-- 3. A NEW invoice for the next cycle snaps the bucket back to the grant.
do $$
declare
  v_user uuid := '44444444-4444-4444-8444-444444444444'; v_plan int;
begin
  insert into auth.users (id, email) values (v_user, 'cycle@example.com') on conflict do nothing;
  insert into public.profiles (id, birth_date) values (v_user, '1990-01-01') on conflict do nothing;
  perform public.fn_apply_fulfillment('stripe','in_c1',v_user,'subscription_grant','studio',1500,
    now() + interval '30 days', now(), null, false, false);
  insert into public.ledger_entries (user_id, type, bucket, amount_credits, note)
    values (v_user,'generate','plan',-1400,'spend');
  perform public.fn_apply_fulfillment('stripe','in_c2',v_user,'subscription_grant','studio',1500,
    now() + interval '60 days', now(), null, false, false);
  select bal.plan_credits into v_plan from public.fn_balances(v_user) bal;
  assert v_plan = 1500, format('next cycle must snap to 1500, got %s', v_plan);
end $$;

-- 4. An out-of-order delivery of an OLDER period is refused, not applied.
do $$
declare
  v_user uuid := '55555555-5555-4555-8555-555555555555'; v_out jsonb; v_end timestamptz;
begin
  insert into auth.users (id, email) values (v_user, 'stale@example.com') on conflict do nothing;
  insert into public.profiles (id, birth_date) values (v_user, '1990-01-01') on conflict do nothing;
  perform public.fn_apply_fulfillment('stripe','in_s2',v_user,'subscription_grant','pro',3750,
    now() + interval '60 days', now(),
    jsonb_build_object('plan','pro','status','active',
      'current_period_end',(now() + interval '60 days')::text), false, false);
  v_out := public.fn_apply_fulfillment('stripe','in_s1',v_user,'subscription_grant','pro',3750,
    now() + interval '30 days', now() - interval '1 hour',
    jsonb_build_object('plan','pro','status','active',
      'current_period_end',(now() + interval '30 days')::text), false, false);
  assert v_out->>'reason' = 'stale_period', 'older period must be refused';
  select current_period_end into v_end from public.subscriptions where user_id = v_user;
  assert v_end > now() + interval '45 days', 'entitlement must not move backwards';
end $$;

-- 5. An upgrade tops up but never takes credits away.
do $$
declare
  v_user uuid := '66666666-6666-4666-8666-666666666666'; v_plan int;
begin
  insert into auth.users (id, email) values (v_user, 'upgrade@example.com') on conflict do nothing;
  insert into public.profiles (id, birth_date) values (v_user, '1990-01-01') on conflict do nothing;
  perform public.fn_apply_fulfillment('stripe','in_u1',v_user,'subscription_grant','pro',3750,
    now() + interval '30 days', now(), null, false, false);
  perform public.fn_apply_fulfillment('stripe','in_u2',v_user,'subscription_grant','studio',1500,
    now() + interval '30 days', now(), null, true, false);
  select bal.plan_credits into v_plan from public.fn_balances(v_user) bal;
  assert v_plan = 3750, format('never_lower must keep 3750, got %s', v_plan);
end $$;

-- 6. A pack grant is once-only even if the caller retries.
do $$
declare
  v_user uuid := '77777777-7777-4777-8777-777777777777'; v_pack int;
begin
  insert into auth.users (id, email) values (v_user, 'pack@example.com') on conflict do nothing;
  insert into public.profiles (id, birth_date) values (v_user, '1990-01-01') on conflict do nothing;
  perform public.fn_apply_fulfillment('stripe','cs_p1',v_user,'pack_grant',null,1500,
    null, now(), null, false, false);
  perform public.fn_apply_fulfillment('stripe','cs_p1',v_user,'pack_grant',null,1500,
    null, now(), null, false, false);
  select bal.pack_credits into v_pack from public.fn_balances(v_user) bal;
  assert v_pack = 1500, format('pack granted twice: got %s', v_pack);
end $$;

-- 7. An Apple transaction and a Stripe transaction with the same id do not collide.
do $$
declare
  v_user uuid := '88888888-8888-4888-8888-888888888888'; v_pack int;
begin
  insert into auth.users (id, email) values (v_user, 'both@example.com') on conflict do nothing;
  insert into public.profiles (id, birth_date) values (v_user, '1990-01-01') on conflict do nothing;
  perform public.fn_apply_fulfillment('stripe','shared_id',v_user,'pack_grant',null,1000,
    null, now(), null, false, false);
  perform public.fn_apply_fulfillment('apple','shared_id',v_user,'pack_grant',null,1000,
    null, now(), null, false, false);
  select bal.pack_credits into v_pack from public.fn_balances(v_user) bal;
  assert v_pack = 2000, format('sources must be independent: got %s', v_pack);
end $$;

-- 8. The reconciliation report is empty for a healthy history.
do $$
declare v_rows int;
begin
  select count(*) into v_rows from public.fn_paid_unfulfilled(now() - interval '1 day');
  assert v_rows = 0, format('unexpected unfulfilled rows: %s', v_rows);
end $$;
```

- [x] **Step 4: Run the full SQL suite**

```bash
cd /Users/user/IdeaProjects/vansen && psql "$VANSEN_LOCAL_DB" -v ON_ERROR_STOP=1 -f supabase/tests/billing_transactions.sql
```

Expected: one `DO` line per block, then `ROLLBACK`, with no `ERROR`.

- [x] **Step 5: Prove the concurrency claim with two real sessions**

The advisory lock is the whole point of the design, so it gets a test that actually races. Create `supabase/tests/billing_concurrency.sh`:

```bash
#!/usr/bin/env bash
# Two simultaneous deliveries of the SAME invoice must grant once.
# LOCAL DATABASE ONLY.
set -euo pipefail
DB="${VANSEN_LOCAL_DB:?set VANSEN_LOCAL_DB first}"
USER_ID='99999999-9999-4999-8999-999999999999'

psql "$DB" -v ON_ERROR_STOP=1 -q -c "
  insert into auth.users (id, email) values ('$USER_ID','race@example.com') on conflict do nothing;
  insert into public.profiles (id, birth_date) values ('$USER_ID','1990-01-01') on conflict do nothing;
  delete from public.ledger_entries where user_id = '$USER_ID';
  delete from public.billing_transactions where user_id = '$USER_ID';
"

CALL="select public.fn_apply_fulfillment('stripe','in_race','$USER_ID','subscription_grant','studio',1500,now()+interval '30 days',now(),null,false,false);"
psql "$DB" -q -c "$CALL" > /dev/null &
psql "$DB" -q -c "$CALL" > /dev/null &
wait

GRANTS=$(psql "$DB" -t -A -c "select count(*) from public.ledger_entries where user_id='$USER_ID' and type='cycle_reset';")
ROWS=$(psql "$DB" -t -A -c "select count(*) from public.billing_transactions where user_id='$USER_ID';")

psql "$DB" -q -c "
  delete from public.ledger_entries where user_id='$USER_ID';
  delete from public.billing_transactions where user_id='$USER_ID';
  delete from public.profiles where id='$USER_ID';
  delete from auth.users where id='$USER_ID';
"

test "$GRANTS" = "1" || { echo "FAIL: expected 1 grant, got $GRANTS"; exit 1; }
test "$ROWS" = "1" || { echo "FAIL: expected 1 applied transaction, got $ROWS"; exit 1; }
echo "OK: concurrent delivery granted once"
```

- [x] **Step 6: Run the race test**

```bash
cd /Users/user/IdeaProjects/vansen && chmod +x supabase/tests/billing_concurrency.sh && ./supabase/tests/billing_concurrency.sh
```

Expected: `OK: concurrent delivery granted once`. User commits.

---

## Task 3: The fulfillment client module

**Files:**
- Create: `supabase/functions/_shared/billing-fulfillment.ts`, `supabase/functions/_shared/billing-fulfillment_test.ts`

**Interfaces:**
- Consumes: `FakeDb` from `_shared/testing/fakes.ts` (Task 1).
- Produces:
  ```ts
  export type FulfillmentKind = 'subscription_grant' | 'pack_grant' | 'clawback';
  export interface FulfillmentRequest {
    source: 'stripe' | 'apple';
    businessTxnId: string;
    userId: string;
    kind: FulfillmentKind;
    plan?: 'studio' | 'pro' | null;
    credits: number;
    periodEnd?: string | null;
    eventAt: string;
    entitlement?: Record<string, unknown> | null;
    neverLower?: boolean;
    clearPending?: boolean;
  }
  export interface FulfillmentResult {
    applied: boolean;
    replay: boolean;
    reason: string | null;
    credits: { plan: number; pack: number };
    entitlement: string | null;
  }
  export async function applyFulfillment(admin: SupabaseClient, req: FulfillmentRequest): Promise<FulfillmentResult>;
  export function isDuplicateKey(error: { code?: string } | null): boolean;
  ```
  `applyFulfillment` **throws** on any RPC error. Callers translate a throw into a 5xx so the provider retries; they never swallow it.

- [x] **Step 1: Write the failing test**

Create `supabase/functions/_shared/billing-fulfillment_test.ts`:

```ts
import { assertEquals, assertRejects } from 'jsr:@std/assert';
import { FakeDb, TEST_USER } from './testing/fakes.ts';
import { applyFulfillment, isDuplicateKey } from './billing-fulfillment.ts';

function db(): FakeDb {
  const d = new FakeDb();
  d.rpcHandlers.fn_apply_fulfillment = () => ({
    applied: true, replay: false, reason: null,
    credits: { plan: 1500, pack: 0 }, entitlement: 'studio',
  });
  return d;
}

Deno.test('maps the request onto the rpc argument names', async () => {
  const d = db();
  await applyFulfillment(d as never, {
    source: 'stripe',
    businessTxnId: 'in_1',
    userId: TEST_USER,
    kind: 'subscription_grant',
    plan: 'studio',
    credits: 1500,
    periodEnd: '2026-10-20T00:00:00.000Z',
    eventAt: '2026-09-20T00:00:00.000Z',
    entitlement: { plan: 'studio', status: 'active' },
    neverLower: true,
    clearPending: true,
  });
  assertEquals(d.rpcCalls[0].name, 'fn_apply_fulfillment');
  assertEquals(d.rpcCalls[0].args, {
    p_source: 'stripe',
    p_txn_id: 'in_1',
    p_user: TEST_USER,
    p_kind: 'subscription_grant',
    p_plan: 'studio',
    p_credits: 1500,
    p_period_end: '2026-10-20T00:00:00.000Z',
    p_event_at: '2026-09-20T00:00:00.000Z',
    p_entitlement: { plan: 'studio', status: 'active' },
    p_never_lower: true,
    p_clear_pending: true,
  });
});

Deno.test('returns the rpc result verbatim', async () => {
  const result = await applyFulfillment(db() as never, {
    source: 'stripe', businessTxnId: 'in_1', userId: TEST_USER,
    kind: 'subscription_grant', plan: 'studio', credits: 1500,
    eventAt: '2026-09-20T00:00:00.000Z',
  });
  assertEquals(result.applied, true);
  assertEquals(result.credits, { plan: 1500, pack: 0 });
});

Deno.test('an rpc error throws so the caller can answer 5xx', async () => {
  const d = db();
  d.failNext('rpc.fn_apply_fulfillment', 'deadlock detected', '40P01');
  await assertRejects(
    () =>
      applyFulfillment(d as never, {
        source: 'stripe', businessTxnId: 'in_1', userId: TEST_USER,
        kind: 'pack_grant', credits: 100, eventAt: '2026-09-20T00:00:00.000Z',
      }),
    Error,
    'deadlock detected',
  );
});

Deno.test('a missing result throws rather than reporting a phantom grant', async () => {
  const d = new FakeDb();
  d.rpcHandlers.fn_apply_fulfillment = () => null;
  await assertRejects(() =>
    applyFulfillment(d as never, {
      source: 'apple', businessTxnId: 'tx_1', userId: TEST_USER,
      kind: 'pack_grant', credits: 100, eventAt: '2026-09-20T00:00:00.000Z',
    })
  );
});

Deno.test('isDuplicateKey distinguishes 23505 from operational errors', () => {
  assertEquals(isDuplicateKey({ code: '23505' }), true);
  assertEquals(isDuplicateKey({ code: '40P01' }), false);
  assertEquals(isDuplicateKey({ code: '08006' }), false);
  assertEquals(isDuplicateKey({}), false);
  assertEquals(isDuplicateKey(null), false);
});
```

- [x] **Step 2: Run to verify it fails**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all _shared/billing-fulfillment_test.ts
```

Expected: FAIL — `Module not found "file:///.../_shared/billing-fulfillment.ts"`.

- [x] **Step 3: Write `_shared/billing-fulfillment.ts`**

```ts
// The only path from verified provider money to a credit balance.
//
// Everything about "did this already happen" lives in the database, inside the
// same transaction as the effect. This module's job is to name the business
// transaction correctly — the Stripe invoice/session id, the Apple transaction
// id, never the event delivery id — and to refuse to guess when the RPC does
// not answer.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';

export type FulfillmentKind = 'subscription_grant' | 'pack_grant' | 'clawback';

export interface FulfillmentRequest {
  source: 'stripe' | 'apple';
  /** Stable across redeliveries: invoice id, checkout session id, Apple transactionId. */
  businessTxnId: string;
  userId: string;
  kind: FulfillmentKind;
  plan?: 'studio' | 'pro' | null;
  credits: number;
  periodEnd?: string | null;
  eventAt: string;
  /** Finished `subscriptions` row patch, or null to leave the mirror alone. */
  entitlement?: Record<string, unknown> | null;
  /** Upgrade semantics: top the plan bucket up, never take credits away. */
  neverLower?: boolean;
  clearPending?: boolean;
}

export interface FulfillmentResult {
  applied: boolean;
  replay: boolean;
  reason: string | null;
  credits: { plan: number; pack: number };
  entitlement: string | null;
}

export async function applyFulfillment(
  admin: SupabaseClient,
  req: FulfillmentRequest,
): Promise<FulfillmentResult> {
  const { data, error } = await admin.rpc('fn_apply_fulfillment', {
    p_source: req.source,
    p_txn_id: req.businessTxnId,
    p_user: req.userId,
    p_kind: req.kind,
    p_plan: req.plan ?? null,
    p_credits: req.credits,
    p_period_end: req.periodEnd ?? null,
    p_event_at: req.eventAt,
    p_entitlement: req.entitlement ?? null,
    p_never_lower: req.neverLower ?? false,
    p_clear_pending: req.clearPending ?? false,
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error('fn_apply_fulfillment returned no result');
  return data as FulfillmentResult;
}

/** Postgres unique-violation. Anything else is operational and must retry. */
export function isDuplicateKey(error: { code?: string } | null): boolean {
  return error?.code === '23505';
}
```

- [x] **Step 4: Run to verify it passes**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all _shared/billing-fulfillment_test.ts
```

Expected: `5 passed | 0 failed`. User commits.

---

## Task 4: Stripe webhook — testable, transactional, full grant (D1)

**Files:**
- Create: `supabase/functions/stripe-webhook/handler.ts`, `supabase/functions/stripe-webhook/handler_test.ts`
- Modify: `supabase/functions/stripe-webhook/index.ts`

**Interfaces:**
- Consumes: `applyFulfillment`, `isDuplicateKey` (Task 3); `FakeDb` (Task 1).
- Produces:
  ```ts
  export interface StripeWebhookDeps {
    admin: SupabaseClient;
    constructEvent(payload: string, signature: string): Promise<Stripe.Event>;
    retrieveSubscription(id: string): Promise<Stripe.Subscription>;
    priceIds: { studio?: string; pro?: string };
  }
  export function createStripeWebhook(deps: StripeWebhookDeps): (req: Request) => Promise<Response>;
  export function cycleGrant(plan: 'studio'|'pro', billingReason: string|null, amountPaid: number):
    { credits: number; neverLower: boolean } | null;
  export function stripeEntitlement(sub: Stripe.Subscription, plan: 'studio'|'pro', periodEnd: string):
    Record<string, unknown>;
  ```

**Pack input contract:** Add `retrievePackPurchase(sessionId): Promise<{usd:number; plan:'studio'|'pro'}>` to `StripeWebhookDeps` and its fake. Production implementation reads the Stripe line item and the server-created checkout purchase record (plan/rate at purchase time), checks an allowlisted pack price/quantity/currency and session owner, then returns that record. Import `packCredits` from the shared catalog; never consume a numeric grant from session metadata. Signed Stripe metadata is not inherently client-controlled, but a grant field is not the authoritative catalog calculation. Unknown price, owner or stored purchase returns a retriable reconciliation error, not a guessed rate. Test tampered `pack_credits` cannot change the calculated grant.

For subscription mirror-only writes, check the returned database error and use a server-side ordering condition on verified provider event/current period; a late webhook cannot reactivate a revoked/newer entitlement. Include this in the same per-user lock as fulfillment.

- [x] **Step 1: Write the failing test**

Create `supabase/functions/stripe-webhook/handler_test.ts`:

```ts
import { assertEquals } from 'jsr:@std/assert';
import type Stripe from 'npm:stripe@17';
import { FakeDb, TEST_USER } from './_shared/testing/fakes.ts';
import { createStripeWebhook, cycleGrant } from './handler.ts';

function fakeDb(): FakeDb {
  const d = new FakeDb();
  d.primaryKeys.webhook_events = 'id';
  d.tables.webhook_events = [];
  d.tables.subscriptions = [];
  d.rpcHandlers.fn_apply_fulfillment = (args, db) => {
    db.tables.applied ??= [];
    db.tables.applied.push({ ...args });
    return { applied: true, replay: false, reason: null, credits: { plan: 1500, pack: 0 }, entitlement: args.p_plan };
  };
  return d;
}

function subscription(over: Record<string, unknown> = {}): Stripe.Subscription {
  return {
    id: 'sub_1',
    status: 'active',
    cancel_at_period_end: false,
    metadata: { user_id: TEST_USER, plan: 'studio' },
    items: { data: [{ price: { id: 'price_studio' }, current_period_end: 1790000000 }] },
    ...over,
  } as unknown as Stripe.Subscription;
}

function deps(db: FakeDb, event: Stripe.Event, sub = subscription()) {
  return {
    admin: db as never,
    constructEvent: () => Promise.resolve(event),
    retrieveSubscription: () => Promise.resolve(sub),
    priceIds: { studio: 'price_studio', pro: 'price_pro' },
  };
}

function post(): Request {
  return new Request('https://x/', {
    method: 'POST',
    headers: { 'stripe-signature': 't=1,v1=sig' },
    body: '{}',
  });
}

function invoicePaid(id: string, over: Record<string, unknown> = {}): Stripe.Event {
  return {
    id: `evt_${id}`,
    type: 'invoice.paid',
    data: {
      object: {
        id,
        subtotal: 1500,
        amount_paid: 1000,
        billing_reason: 'subscription_cycle',
        total_discount_amounts: [{ amount: 500 }],
        subscription: 'sub_1',
        ...over,
      },
    },
  } as unknown as Stripe.Event;
}

Deno.test('D1: a launch-coupon invoice grants the FULL plan credits', () => {
  assertEquals(cycleGrant('studio', 'subscription_cycle', 1000), { credits: 1500, neverLower: false });
  assertEquals(cycleGrant('pro', 'subscription_create', 2500), { credits: 3750, neverLower: false });
});

Deno.test('D1: a full-price invoice grants the full plan credits', () => {
  assertEquals(cycleGrant('studio', 'subscription_cycle', 1500), { credits: 1500, neverLower: false });
});

Deno.test('D1: a prorated upgrade tops up and never lowers', () => {
  assertEquals(cycleGrant('pro', 'subscription_update', 900), { credits: 3750, neverLower: true });
});

Deno.test('D1: a verified zero-amount discounted cycle receives its plan grant', () => {
  assertEquals(cycleGrant('studio', 'subscription_cycle', 0), { credits: 1500, neverLower: false });
});

Deno.test('invoice.paid uses the INVOICE id as the business transaction', async () => {
  const db = fakeDb();
  const res = await createStripeWebhook(deps(db, invoicePaid('in_42')))(post());
  assertEquals(res.status, 200);
  assertEquals(db.tables.applied.length, 1);
  assertEquals(db.tables.applied[0].p_txn_id, 'in_42');
  assertEquals(db.tables.applied[0].p_source, 'stripe');
  assertEquals(db.tables.applied[0].p_credits, 1500);
});

Deno.test('a redelivered event still reaches the idempotent rpc', async () => {
  const db = fakeDb();
  db.tables.webhook_events = [{ id: 'evt_in_42', type: 'invoice.paid' }];
  const res = await createStripeWebhook(deps(db, invoicePaid('in_42')))(post());
  assertEquals(res.status, 200);
  assertEquals(db.tables.applied.length, 1);
});

Deno.test('an operational db error answers 500 so stripe retries', async () => {
  const db = fakeDb();
  db.failNext('rpc.fn_apply_fulfillment', 'connection reset', '08006');
  const res = await createStripeWebhook(deps(db, invoicePaid('in_43')))(post());
  assertEquals(res.status, 500);
});

Deno.test('a failed run does NOT leave a delivery marker that blocks the retry', async () => {
  const db = fakeDb();
  db.failNext('rpc.fn_apply_fulfillment', 'connection reset', '08006');
  await createStripeWebhook(deps(db, invoicePaid('in_44')))(post());
  assertEquals(db.tables.webhook_events.filter((e) => e.id === 'evt_in_44').length, 0);
});

Deno.test('a pack checkout with a mismatched amount is refused, not silently dropped', async () => {
  const db = fakeDb();
  const event = {
    id: 'evt_cs_1',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_1',
        mode: 'payment',
        payment_status: 'paid',
        amount_subtotal: 500,
        metadata: { user_id: TEST_USER, pack_usd: '10', pack_credits: '1500' },
      },
    },
  } as unknown as Stripe.Event;
  const res = await createStripeWebhook(deps(db, event))(post());
  assertEquals(res.status, 500);
  assertEquals(db.tables.applied ?? [], []);
  assertEquals(db.tables.webhook_events.filter((e) => e.id === 'evt_cs_1').length, 0);
});

Deno.test('a matching pack checkout uses the SESSION id as the business transaction', async () => {
  const db = fakeDb();
  const event = {
    id: 'evt_cs_2',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_2',
        mode: 'payment',
        payment_status: 'paid',
        amount_subtotal: 1000,
        metadata: { user_id: TEST_USER, pack_usd: '10', pack_credits: '1500' },
      },
    },
  } as unknown as Stripe.Event;
  const res = await createStripeWebhook(deps(db, event))(post());
  assertEquals(res.status, 200);
  assertEquals(db.tables.applied[0].p_txn_id, 'cs_2');
  assertEquals(db.tables.applied[0].p_kind, 'pack_grant');
  assertEquals(db.tables.applied[0].p_credits, 1500);
});

Deno.test('an invalid signature answers 400 and touches nothing', async () => {
  const db = fakeDb();
  const handler = createStripeWebhook({
    ...deps(db, invoicePaid('in_45')),
    constructEvent: () => Promise.reject(new Error('bad signature')),
  });
  assertEquals((await handler(post())).status, 400);
  assertEquals(db.tables.applied ?? [], []);
});

Deno.test('a canceled subscription never grants', async () => {
  const db = fakeDb();
  const sub = subscription({ status: 'canceled' });
  const res = await createStripeWebhook(deps(db, invoicePaid('in_46'), sub))(post());
  assertEquals(res.status, 200);
  assertEquals(db.tables.applied ?? [], []);
});
```

- [x] **Step 2: Run to verify it fails**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all stripe-webhook/handler_test.ts
```

Expected: FAIL — `Module not found "file:///.../stripe-webhook/handler.ts"`.

- [x] **Step 3: Write `stripe-webhook/handler.ts`**

Move the existing helpers (`invoiceSubscriptionId`, `periodEndIso`, `planFor`) across unchanged, then:

```ts
// Stripe webhook consumer. Trust anchor: the Stripe signature (no JWT). All
// money goes through fn_apply_fulfillment, which is idempotent on the BUSINESS
// transaction — the invoice or session id, which Stripe keeps stable across
// redeliveries — so this handler never has to decide whether a retry is safe.
//
// webhook_events is now only a delivery marker for observability. It is written
// AFTER the work commits, so a crashed run leaves nothing behind to skip.
import type Stripe from 'npm:stripe@17';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { PLAN_CREDITS } from './_shared/model-families.ts';
import { applyFulfillment } from './_shared/billing-fulfillment.ts';

export interface StripeWebhookDeps {
  admin: SupabaseClient;
  constructEvent(payload: string, signature: string): Promise<Stripe.Event>;
  retrieveSubscription(id: string): Promise<Stripe.Subscription>;
  priceIds: { studio?: string; pro?: string };
}

// ... invoiceSubscriptionId, periodEndIso unchanged ...

/**
 * D1 (vansen.md §5): the launch promotion is "first 2 cycles $10 / $25 with
 * FULL credit grant". Grants therefore follow the plan, not the money paid.
 * A verified paid subscription cycle grants the full amount even with a 100% discount.
 * A prorated upgrade tops the bucket up to the new plan without ever taking
 * credits away from someone who just paid more.
 */
export function cycleGrant(
  plan: 'studio' | 'pro',
  billingReason: string | null,
  amountPaid: number,
): { credits: number; neverLower: boolean } | null {
  if (!['subscription_create', 'subscription_cycle', 'subscription_update'].includes(billingReason ?? '')) return null;
  if (amountPaid < 0) throw new Error('invalid_invoice_amount');
  const neverLower = billingReason === 'subscription_update';
  return { credits: PLAN_CREDITS[plan], neverLower };
}

/** The `subscriptions` mirror patch. Same status mapping as before. */
export function stripeEntitlement(
  sub: Stripe.Subscription,
  plan: 'studio' | 'pro',
  periodEnd: string,
): Record<string, unknown> {
  const alive = sub.status === 'active' || sub.status === 'trialing' || sub.status === 'past_due';
  const status = alive ? (sub.cancel_at_period_end ? 'canceled' : 'active') : 'expired';
  return {
    plan,
    status,
    current_period_end: periodEnd,
    stripe_subscription_id: sub.id,
    cancel_reason: sub.cancel_at_period_end ? (sub.metadata?.cancel_reason || null) : null,
  };
}

export function createStripeWebhook(deps: StripeWebhookDeps): (req: Request) => Promise<Response> {
  const { admin, constructEvent, retrieveSubscription, priceIds } = deps;

  function planFor(sub: Stripe.Subscription): 'studio' | 'pro' {
    const priceId = sub.items.data[0]?.price?.id;
    if (priceId === priceIds.pro) return 'pro';
    if (priceId === priceIds.studio) return 'studio';
    throw new Error('unrecognized_subscription_price');
  }

  /** A scheduled change is done the moment the subscription reports the new price. */
  async function pendingDone(userId: string, plan: string): Promise<boolean> {
    const { data } = await admin
      .from('subscriptions')
      .select('pending_plan')
      .eq('user_id', userId)
      .maybeSingle();
    return data?.pending_plan != null && data.pending_plan === plan;
  }

  async function handleInvoicePaid(event: Stripe.Event): Promise<void> {
    const invoice = event.data.object as Stripe.Invoice;
    const subId = invoiceSubscriptionId(invoice);
    if (!subId) return;
    const sub = await retrieveSubscription(subId);
    const userId = sub.metadata?.user_id;
    if (!userId) return;
    const alive = sub.status === 'active' || sub.status === 'trialing' || sub.status === 'past_due';
    if (!alive) return;
    const plan = planFor(sub);
    const periodEnd = periodEndIso(sub);
    const grant = cycleGrant(plan, invoice.billing_reason ?? null, invoice.amount_paid ?? 0);
    if (!grant) {
      console.info('non_cycle_invoice_not_granted', invoice.id);
      return;
    }
    await applyFulfillment(admin, {
      source: 'stripe',
      businessTxnId: String(invoice.id),
      userId,
      kind: 'subscription_grant',
      plan,
      credits: grant.credits,
      periodEnd,
      eventAt: new Date(event.created * 1000).toISOString(),
      entitlement: stripeEntitlement(sub, plan, periodEnd),
      neverLower: grant.neverLower,
      clearPending: await pendingDone(userId, plan),
    });
  }

  async function handleCheckout(event: Stripe.Event): Promise<void> {
    const session = event.data.object as Stripe.Checkout.Session;
    if (session.payment_status !== 'paid') return;
    const userId = session.metadata?.user_id;
    if (!userId) return;

    if (session.mode === 'subscription' && session.subscription) {
      const sub = await retrieveSubscription(String(session.subscription));
      const plan = planFor(sub);
      const periodEnd = periodEndIso(sub);
      // Mirror only. The grant lands on invoice.paid, which fires for the
      // first invoice too and carries the id we key the grant on.
      await admin.from('subscriptions').upsert(
        { user_id: userId, ...stripeEntitlement(sub, plan, periodEnd), updated_at: new Date().toISOString() },
        { onConflict: 'user_id' },
      );
      return;
    }

    if (session.mode !== 'payment') return;
    const purchase = await deps.retrievePackPurchase(String(session.id));
    const { usd, plan } = purchase;
    const credits = packCredits(usd, plan);
    if (!Number.isSafeInteger(credits) || credits <= 0) throw new Error('invalid_pack_purchase');
    // Integrity: our own metadata must agree with Stripe's subtotal. A mismatch
    // is a bug or an attack, never a routine case — it throws so the delivery
    // is retried and the discrepancy stays visible instead of being consumed.
    if (session.amount_subtotal !== usd * 100) {
      throw new Error(
        `pack amount mismatch ${session.id}: subtotal ${session.amount_subtotal} vs ${usd * 100}`,
      );
    }
    await applyFulfillment(admin, {
      source: 'stripe',
      businessTxnId: String(session.id),
      userId,
      kind: 'pack_grant',
      credits,
      eventAt: new Date(event.created * 1000).toISOString(),
    });
  }

  async function handleSubscriptionChanged(event: Stripe.Event): Promise<void> {
    // Re-fetch rather than trust event.data.object: Stripe renders webhook
    // payloads with the ACCOUNT's default API version, which may drop fields
    // we read. retrieve() always answers in the pinned shape.
    const raw = event.data.object as Stripe.Subscription;
    const userId = raw.metadata?.user_id;
    if (!userId) return;
    const sub = await retrieveSubscription(raw.id);
    const plan = planFor(sub);
    const periodEnd = periodEndIso(sub);
    const clear = await pendingDone(userId, plan);
    await admin.from('subscriptions').upsert(
      {
        user_id: userId,
        ...stripeEntitlement(sub, plan, periodEnd),
        ...(clear ? { pending_plan: null, pending_at: null } : {}),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    );
  }

  return async function handle(req: Request): Promise<Response> {
    const signature = req.headers.get('stripe-signature');
    if (!signature) return new Response('missing signature', { status: 400 });
    const payload = await req.text();

    let event: Stripe.Event;
    try {
      event = await constructEvent(payload, signature);
    } catch {
      return new Response('invalid signature', { status: 400 });
    }

    try {
      if (event.type === 'invoice.paid') await handleInvoicePaid(event);
      if (event.type === 'checkout.session.completed') await handleCheckout(event);
      if (event.type === 'checkout.session.async_payment_succeeded') await handleCheckout(event);
      if (event.type === 'customer.subscription.updated') await handleSubscriptionChanged(event);
      if (event.type === 'customer.subscription.deleted') await handleSubscriptionChanged(event);
      if (event.type === 'invoice.payment_failed') {
        console.error('payment_failed invoice', (event.data.object as Stripe.Invoice).id);
      }
      // Delivery marker, written last and best-effort: it exists for the
      // operator's timeline, never as an idempotency gate.
      await admin.from('webhook_events').insert({ id: event.id, type: event.type });
      return new Response('ok', { status: 200 });
    } catch (e) {
      console.error('webhook processing failed:', event.id, e);
      return new Response('processing failed', { status: 500 });
    }
  };
}
```

- [x] **Step 4: Rewrite `stripe-webhook/index.ts` as composition**

```ts
// Production composition for the Stripe webhook. Behaviour lives in handler.ts.
import Stripe from 'npm:stripe@17';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { createStripeWebhook } from './handler.ts';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2024-06-20' as Stripe.LatestApiVersion,
  httpClient: Stripe.createFetchHttpClient(),
});
const cryptoProvider = Stripe.createSubtleCryptoProvider();
const WEBHOOK_SECRET = Deno.env.get('STRIPE_WEBHOOK_SECRET')!;

const handler = createStripeWebhook({
  admin: createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  ),
  constructEvent: (payload, signature) =>
    stripe.webhooks.constructEventAsync(payload, signature, WEBHOOK_SECRET, undefined, cryptoProvider),
  retrieveSubscription: (id) => stripe.subscriptions.retrieve(id),
  priceIds: {
    studio: Deno.env.get('STRIPE_STUDIO_PRICE_ID'),
    pro: Deno.env.get('STRIPE_PRO_PRICE_ID'),
  },
});

Deno.serve(handler);
```

- [x] **Step 5: Run the tests**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno check stripe-webhook/index.ts && deno test --allow-all stripe-webhook
```

Expected: `12 passed | 0 failed`. User commits.

---

## Task 5: Apple webhook and `/iap/verify` — one path, no orphan markers

**Files:**
- Modify: `supabase/functions/_shared/iap-grants.ts`
- Create: `supabase/functions/appstore-webhook/handler.ts`, `supabase/functions/appstore-webhook/handler_test.ts`
- Modify: `supabase/functions/appstore-webhook/index.ts`, `supabase/functions/api/app.ts` (`/iap/verify`)

**Interfaces:**
- Consumes: `applyFulfillment` (Task 3).
- Produces:
  ```ts
  export type IapOutcome = 'applied' | 'already_applied' | 'rejected';
  export async function applyIapTransaction(admin, userId, tx): Promise<{ outcome: IapOutcome; credits: {plan:number;pack:number} | null }>;
  export function createAppstoreWebhook(deps: AppstoreWebhookDeps): (req: Request) => Promise<Response>;
  ```
  `POST /iap/verify` answers `{ outcome, credits }` with `outcome` one of `applied | already_applied | rejected | retry_later`, and HTTP 503 for `retry_later`.

**The defect being removed:** `iap-grants.ts:28–31` inserts an `iaptx:<transactionId>` marker and returns `false` on **any** insert error, then does the grant with no marker cleanup. A grant that throws after the marker lands is never retried, because the next delivery sees the marker and returns early. `appstore-webhook/index.ts:44` compounds it by deleting only the `notificationUUID` row on failure, leaving the `iaptx:` marker in place. The marker is deleted outright; `billing_transactions` replaces it with a marker that is written in the same transaction as the money.

- [x] **Step 1: Write the failing test**

Create `supabase/functions/appstore-webhook/handler_test.ts`:

```ts
import { assertEquals } from 'jsr:@std/assert';
import { FakeDb, TEST_USER } from './_shared/testing/fakes.ts';
import { createAppstoreWebhook } from './handler.ts';

function fakeDb(): FakeDb {
  const d = new FakeDb();
  d.primaryKeys.webhook_events = 'id';
  d.tables.webhook_events = [];
  d.tables.subscriptions = [];
  d.rpcHandlers.fn_apply_fulfillment = (args, db) => {
    db.tables.applied ??= [];
    db.tables.applied.push({ ...args });
    return { applied: true, replay: false, reason: null, credits: { plan: 1500, pack: 0 }, entitlement: args.p_plan };
  };
  return d;
}

const NOTIFICATION = {
  notificationUUID: 'uuid-1',
  notificationType: 'SUBSCRIBED',
  subtype: 'INITIAL_BUY',
  data: { signedTransactionInfo: 'jws' },
};

function deps(db: FakeDb, over: Record<string, unknown> = {}) {
  return {
    admin: db as never,
    verifyNotification: () => Promise.resolve(NOTIFICATION),
    verifyTransaction: () =>
      Promise.resolve({
        productId: 'vansen.studio.monthly',
        transactionId: 'tx_1',
        originalTransactionId: 'otx_1',
        expiresDate: Date.parse('2026-10-20T00:00:00.000Z'),
        appAccountToken: TEST_USER,
      }),
    ...over,
  };
}

function post(): Request {
  return new Request('https://x/', { method: 'POST', body: JSON.stringify({ signedPayload: 'jws' }) });
}

Deno.test('a subscription notification grants once, keyed on the apple transaction id', async () => {
  const db = fakeDb();
  const res = await createAppstoreWebhook(deps(db))(post());
  assertEquals(res.status, 200);
  assertEquals(db.tables.applied.length, 1);
  assertEquals(db.tables.applied[0].p_source, 'apple');
  assertEquals(db.tables.applied[0].p_txn_id, 'tx_1');
  assertEquals(db.tables.applied[0].p_credits, 1500);
});

Deno.test('a failed grant leaves NO marker that would skip the retry', async () => {
  const db = fakeDb();
  db.failNext('rpc.fn_apply_fulfillment', 'connection reset', '08006');
  const res = await createAppstoreWebhook(deps(db))(post());
  assertEquals(res.status, 500);
  assertEquals(db.tables.webhook_events, []);
  // The retry must reach the rpc again.
  const retry = await createAppstoreWebhook(deps(db))(post());
  assertEquals(retry.status, 200);
  assertEquals(db.tables.applied.length, 1);
});

Deno.test('a replayed notification is answered 200 without a second grant', async () => {
  const db = fakeDb();
  let calls = 0;
  db.rpcHandlers.fn_apply_fulfillment = (args) => {
    calls += 1;
    if (calls === 1) {
      return { applied: true, replay: false, reason: null, credits: { plan: 1500, pack: 0 }, entitlement: args.p_plan };
    }
    return { applied: false, replay: true, reason: null, credits: { plan: 1500, pack: 0 }, entitlement: args.p_plan };
  };
  assertEquals((await createAppstoreWebhook(deps(db))(post())).status, 200);
  assertEquals((await createAppstoreWebhook(deps(db))(post())).status, 200);
  assertEquals(calls, 2);
});

Deno.test('an unknown product is ignored, not granted', async () => {
  const db = fakeDb();
  const handler = createAppstoreWebhook(
    deps(db, {
      verifyTransaction: () =>
        Promise.resolve({
          productId: 'vansen.unknown',
          transactionId: 'tx_2',
          originalTransactionId: 'otx_2',
          appAccountToken: TEST_USER,
        }),
    }),
  );
  assertEquals((await handler(post())).status, 200);
  assertEquals(db.tables.applied ?? [], []);
});

Deno.test('an invalid signature answers 401 and touches nothing', async () => {
  const db = fakeDb();
  const handler = createAppstoreWebhook(
    deps(db, { verifyNotification: () => Promise.reject(new Error('bad chain')) }),
  );
  assertEquals((await handler(post())).status, 401);
  assertEquals(db.tables.applied ?? [], []);
});

Deno.test('a status-only notification updates the mirror without granting', async () => {
  const db = fakeDb();
  db.tables.subscriptions = [
    { user_id: TEST_USER, plan: 'studio', status: 'active', iap_original_transaction_id: 'otx_1' },
  ];
  const handler = createAppstoreWebhook(
    deps(db, {
      verifyNotification: () =>
        Promise.resolve({ ...NOTIFICATION, notificationType: 'EXPIRED', subtype: 'VOLUNTARY' }),
    }),
  );
  assertEquals((await handler(post())).status, 200);
  assertEquals(db.tables.subscriptions[0].status, 'expired');
  assertEquals(db.tables.applied ?? [], []);
});
```

- [x] **Step 2: Run to verify it fails**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all appstore-webhook/handler_test.ts
```

Expected: FAIL — `Module not found "file:///.../appstore-webhook/handler.ts"`.

- [x] **Step 3: Rewrite `applyIapTransaction` and `clawBackIap` in `_shared/iap-grants.ts`**

Replace lines 1–80 with:

```ts
// The only credit-granting code for iap-source money.
//
// Idempotency lives entirely in fn_apply_fulfillment, keyed on the Apple
// transaction id, inside the same transaction as the grant. The old
// 'iaptx:<transactionId>' marker in webhook_events is GONE: it was written
// before the grant and never cleaned up, so any failure after the marker and
// before the grant lost the customer's credits permanently.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { PLAN_CREDITS } from './model-families.ts';
import { IAP_PRODUCTS, iapGrant, iapPlanFor } from './iap-products.ts';
import { applyFulfillment } from './billing-fulfillment.ts';

export interface IapTransaction {
  productId: string;
  transactionId: string;
  originalTransactionId: string;
  expiresDate?: number;
  revocationDate?: number;
  appAccountToken?: string;
}

export type IapOutcome = 'applied' | 'already_applied' | 'rejected';

function iapOutcome(result: { replay: boolean; applied: boolean }): IapOutcome {
  if (result.replay) return 'already_applied';
  if (!result.applied) return 'rejected';
  return 'applied';
}

export interface IapResult {
  outcome: IapOutcome;
  credits: { plan: number; pack: number } | null;
}

/** Throws on any operational failure so the caller answers 5xx and Apple retries. */
export async function applyIapTransaction(
  admin: SupabaseClient,
  userId: string,
  tx: IapTransaction,
  eventAt = new Date().toISOString(),
  nowMs = Date.now(),
): Promise<IapResult> {
  const product = IAP_PRODUCTS[tx.productId];
  if (!product) {
    console.error('unknown iap product', tx.productId, tx.transactionId);
    return { outcome: 'rejected', credits: null };
  }

  if (tx.revocationDate) return { outcome: 'rejected', credits: null };
  const subscriptionExpired = product.kind === 'subscription'
    && (!tx.expiresDate || tx.expiresDate <= nowMs);
  if (subscriptionExpired) return { outcome: 'rejected', credits: null };
  if (product.kind === 'subscription') {
    const periodEnd = new Date(tx.expiresDate!).toISOString();
    const result = await applyFulfillment(admin, {
      source: 'apple',
      businessTxnId: tx.transactionId,
      userId,
      kind: 'subscription_grant',
      plan: product.plan,
      credits: PLAN_CREDITS[product.plan],
      periodEnd,
      eventAt,
      entitlement: {
        plan: product.plan,
        status: 'active',
        current_period_end: periodEnd,
        iap_original_transaction_id: tx.originalTransactionId,
      },
    });
    return { outcome: iapOutcome(result), credits: result.credits };
  }

  const plan = await currentPlan(admin, userId);
  const result = await applyFulfillment(admin, {
    source: 'apple',
    businessTxnId: tx.transactionId,
    userId,
    kind: 'pack_grant',
    credits: iapGrant(tx.productId, plan),
    eventAt,
  });
  return { outcome: iapOutcome(result), credits: result.credits };
}

export async function clawBackIap(
  admin: SupabaseClient,
  userId: string,
  tx: IapTransaction,
  eventAt = new Date().toISOString(),
): Promise<void> {
  if (iapPlanFor(tx.productId)) {
    await applyFulfillment(admin, {
      source: 'apple',
      businessTxnId: `refund:${tx.transactionId}`,
      userId,
      kind: 'subscription_grant',
      plan: iapPlanFor(tx.productId),
      credits: 0,
      eventAt,
      entitlement: { plan: iapPlanFor(tx.productId), status: 'expired', current_period_end: eventAt },
    });
    return;
  }
  // Claw back exactly what the original grant wrote (rates may have changed).
  const { data: grant } = await admin
    .from('ledger_entries')
    .select('amount_credits')
    .eq('stripe_ref', `apple:${tx.transactionId}`)
    .maybeSingle();
  if (!grant) {
    console.error('refund for unknown iap grant', tx.transactionId);
    return;
  }
  await applyFulfillment(admin, {
    source: 'apple',
    businessTxnId: `refund:${tx.transactionId}`,
    userId,
    kind: 'clawback',
    credits: Number(grant.amount_credits),
    eventAt,
  });
}
```

Retain `findUserByOriginalTransaction`; make `currentPlan` and `setIapSubscriptionStatus` check database errors, enforce the same event/period ordering and never reactivate a closed account; delete `upsertIapSubscription`, which the fulfillment entitlement patch replaces.

The subscription refund carries the known product plan and expires the entitlement. The explicit-column upsert preserves database defaults and existing provider IDs; an incomplete first entitlement is rejected, never filled with a guessed plan or period.

**Receipt and response contract:** Verify signature, app/bundle/environment, product, account token, expiry and revocation before granting. Pass the decoded `revocationDate` into `IapTransaction`. Compare expiry to the injected current clock, not the webhook event's historical timestamp. Keep a separate verified event time for ordering. No fabricated 30-day expiry. Replace nested outcome ternaries above with `if (result.replay)`, `if (!result.applied)`, then return applied. Routes map applied/replay to 200, rejected to a readable 422, operational exceptions to 503 `retry_later`; `retry_later` is an HTTP outcome, never a successful `IapResult`. App Store notification rejection may be acknowledged only after its reason is durable. Test expired, revoked, missing expiry, wrong account, unknown product and database failure for both webhook and `/iap/verify`, including no entitlement activation.

- [x] **Step 4: Write `appstore-webhook/handler.ts`**

```ts
// App Store Server Notifications v2 consumer, mirroring stripe-webhook.
// Trust anchor: Apple's JWS x5c chain (no JWT). All money goes through
// fn_apply_fulfillment, keyed on Apple's transactionId.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { actionFor } from './_shared/iap-notifications.ts';
import {
  applyIapTransaction,
  clawBackIap,
  findUserByOriginalTransaction,
  setIapSubscriptionStatus,
  type IapTransaction,
} from './_shared/iap-grants.ts';

// deno-lint-ignore no-explicit-any
type Decoded = any;

export interface AppstoreWebhookDeps {
  admin: SupabaseClient;
  verifyNotification(signedPayload: string): Promise<Decoded>;
  verifyTransaction(signedTransaction: string): Promise<Decoded>;
}

export function createAppstoreWebhook(deps: AppstoreWebhookDeps): (req: Request) => Promise<Response> {
  const { admin, verifyNotification, verifyTransaction } = deps;

  async function handle(payload: Decoded): Promise<void> {
    const action = actionFor(payload.notificationType ?? '', payload.subtype);
    if (action === 'ignore') return;

    const signedTx = payload.data?.signedTransactionInfo;
    if (!signedTx) {
      console.error('notification without transaction info', payload.notificationUUID);
      return;
    }
    const raw = await verifyTransaction(signedTx);
    const tx: IapTransaction = {
      productId: raw.productId ?? '',
      transactionId: raw.transactionId ?? '',
      originalTransactionId: raw.originalTransactionId ?? '',
      expiresDate: raw.expiresDate,
      revocationDate: raw.revocationDate,
      appAccountToken: raw.appAccountToken,
    };
    const eventAt = payload.signedDate
      ? new Date(payload.signedDate).toISOString()
      : new Date().toISOString();

    if (action === 'set_active' || action === 'set_canceled' || action === 'set_expired') {
      const status = action === 'set_active' ? 'active' : action === 'set_canceled' ? 'canceled' : 'expired';
      await setIapSubscriptionStatus(admin, tx.originalTransactionId, status);
      return;
    }

    const userId = tx.appAccountToken ??
      await findUserByOriginalTransaction(admin, tx.originalTransactionId);
    if (!userId) {
      console.error('no user for iap transaction', tx.originalTransactionId);
      return;
    }

    if (action === 'refund') {
      await clawBackIap(admin, userId, tx, eventAt);
      return;
    }
    await applyIapTransaction(admin, userId, tx, eventAt);
  }

  return async function serve(req: Request): Promise<Response> {
    const body = await req.json().catch(() => null);
    const signedPayload = body?.signedPayload;
    if (typeof signedPayload !== 'string') return new Response('bad request', { status: 400 });

    let payload: Decoded;
    try {
      payload = await verifyNotification(signedPayload);
    } catch {
      return new Response('invalid signature', { status: 401 });
    }

    try {
      await handle(payload);
      // Delivery marker, written last and best-effort, for the operator's
      // timeline only. A duplicate here is expected and harmless.
      await admin
        .from('webhook_events')
        .insert({ id: payload.notificationUUID, type: payload.notificationType ?? 'unknown' });
      return new Response('ok', { status: 200 });
    } catch (e) {
      console.error('appstore webhook failed:', payload.notificationUUID, e);
      return new Response('processing failed', { status: 500 });
    }
  };
}
```

- [x] **Step 5: Rewrite `appstore-webhook/index.ts` as composition**

```ts
// Production composition for the App Store webhook. Behaviour lives in handler.ts.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { appleVerifier } from './_shared/apple-verifier.ts';
import { createAppstoreWebhook } from './handler.ts';

Deno.serve(createAppstoreWebhook({
  admin: createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  ),
  verifyNotification: (p) => appleVerifier().verifyAndDecodeNotification(p),
  verifyTransaction: (t) => appleVerifier().verifyAndDecodeTransaction(t),
}));
```

- [x] **Step 6: Make `/iap/verify` tri-state**

In `supabase/functions/api/app.ts`, replace the body of `POST /iap/verify` after the ownership check:

```ts
    const result = await applyIapTransaction(admin, userId, {
      productId: tx.productId ?? '',
      transactionId: tx.transactionId ?? '',
      originalTransactionId: tx.originalTransactionId ?? '',
      expiresDate: tx.expiresDate,
      revocationDate: tx.revocationDate,
    });
    // The client must be able to tell "your credits are here" from "try again
    // in a moment" — a retryable failure that reads as success strands paid
    // money, and one that reads as a hard error sends the user to support.
    if (result.outcome === 'rejected') return fail(c, 422, 'purchase_rejected', 'This purchase cannot be applied to this account.');
    return c.json({
      outcome: result.outcome,
      credits: result.credits ?? await creditsOf(userId),
    });
  } catch (e) {
    logError(c, 'iap_verify_failed', e);
    const res = fail(c, 503, 'retry_later', 'We could not confirm your purchase yet. It is safe to try again.');
    res.headers.set('retry-after', '10');
    return res;
  }
```

Note the response shape changes from `{granted: boolean, credits}` to `{outcome, credits}`. The Flutter client is the only consumer; the companion mobile plan's **MT-01** updates it. Keep `granted` alongside `outcome` for one release so an un-updated build is not broken:

```ts
    if (result.outcome === 'rejected') return fail(c, 422, 'purchase_rejected', 'This purchase cannot be applied to this account.');
    return c.json({
      granted: result.outcome === 'applied' || result.outcome === 'already_applied',
      outcome: result.outcome,
      credits: result.credits ?? await creditsOf(userId),
    });
```

- [x] **Step 7: Run every edge test**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno check api/index.ts api/app.ts stripe-webhook/index.ts appstore-webhook/index.ts && deno test --allow-all _shared api stripe-webhook appstore-webhook
```

Expected: `128 passed | 0 failed` (105 from P1 + 5 fulfillment + 12 stripe + 6 appstore). User commits.

---

## Task 6: Server-side billing lane enforcement

**Files:**
- Modify: `supabase/functions/api/app.ts` (`/billing/subscribe`, `/billing/pack`, `/billing/lane`)
- Create: `supabase/functions/api/billing_lane_test.ts`

**Interfaces:**
- Consumes: `laneFor` from `_shared/billing-lanes.ts`, `createApp`/`testDeps`.
- Produces: `requireWebLane(c)` inside `createApp`, returning a `Response` when a mobile client must not use Stripe checkout.

**Why:** `/billing/lane` currently only *advises* the client. A mobile build (or anyone sending `x-vansen-client: ios`) can call `/billing/subscribe` and be sold through Stripe in a storefront where Apple requires in-app purchase. The lane must be enforced where the money starts, and an unknown platform or storefront must not read as Android/US.

- [x] **Step 1: Write the failing test**

Create `supabase/functions/api/billing_lane_test.ts`:

```ts
import { assertEquals } from 'jsr:@std/assert';
import { createApp } from './app.ts';
import { FakeDb, TEST_USER, testDeps } from './testing/fakes.ts';

const AUTH = { authorization: 'Bearer test-token' };

function subscribed(db: FakeDb) {
  db.tables.subscriptions = [
    { user_id: TEST_USER, plan: 'studio', status: 'active', current_period_end: '2099-01-01T00:00:00Z' },
  ];
}

function body(extra: Record<string, unknown> = {}) {
  return JSON.stringify({ plan: 'studio', ...extra });
}

Deno.test('an iOS client in a lane-C storefront cannot start a stripe subscription', async () => {
  const deps = testDeps();
  const app = createApp(deps);
  const res = await app.request('/api/billing/subscribe', {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json', 'x-vansen-client': 'ios', 'x-vansen-storefront': 'JP' },
    body: body(),
  });
  assertEquals(res.status, 403);
  assertEquals((await res.json()).error.code, 'lane_not_allowed');
});

Deno.test('an iOS client with NO storefront header is refused, not treated as US', async () => {
  const deps = testDeps();
  const app = createApp(deps);
  const res = await app.request('/api/billing/subscribe', {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json', 'x-vansen-client': 'ios' },
    body: body(),
  });
  assertEquals(res.status, 403);
  assertEquals((await res.json()).error.code, 'lane_not_allowed');
});

Deno.test('an iOS client in a lane-A storefront may use stripe', async () => {
  const deps = testDeps();
  const app = createApp(deps);
  const res = await app.request('/api/billing/subscribe', {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json', 'x-vansen-client': 'ios', 'x-vansen-storefront': 'US' },
    body: body(),
  });
  // Reaches Stripe (which the fake does not implement) rather than being
  // refused by the lane gate.
  assertEquals(res.status === 403, false);
});

Deno.test('the web client is never lane-gated', async () => {
  const deps = testDeps();
  const app = createApp(deps);
  const res = await app.request('/api/billing/subscribe', {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json', 'x-vansen-client': 'web' },
    body: body(),
  });
  assertEquals(res.status === 403, false);
});

Deno.test('packs are lane-gated the same way', async () => {
  const deps = testDeps();
  const db = deps.admin as unknown as FakeDb;
  subscribed(db);
  const app = createApp(deps);
  const res = await app.request('/api/billing/pack', {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json', 'x-vansen-client': 'ios', 'x-vansen-storefront': 'JP' },
    body: JSON.stringify({ usd: 10 }),
  });
  assertEquals(res.status, 403);
  assertEquals((await res.json()).error.code, 'lane_not_allowed');
});

Deno.test('GET /billing/lane refuses to guess an unknown storefront', async () => {
  const app = createApp(testDeps());
  const res = await app.request('/api/billing/lane?platform=ios', { headers: AUTH });
  assertEquals((await res.json()).lane, 'C');
});
```

- [x] **Step 2: Run to verify it fails**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all api/billing_lane_test.ts
```

Expected: FAIL — the iOS requests are not refused; the first three tests report a non-403 status or a `billing_failed` from the empty Stripe fake.

- [x] **Step 3: Add `requireWebLane` and apply it**

Inside `createApp` in `app.ts`, next to `clientOf`:

```ts
  /** Stripe checkout is only allowed where the storefront's rules permit it.
   * An unknown platform or a missing storefront is NOT Android/US — a wrong
   * guess here sells a subscription Apple requires to be an in-app purchase. */
  function requireWebLane(c: Context): Response | null {
    const client = clientOf(c);
    if (client !== 'ios') return null;
    const storefront = (c.req.header('x-vansen-storefront') ?? '').toUpperCase();
    const lane = laneFor('ios', storefront, Deno.env.get('LANE_B') === 'on');
    if (lane === 'A') return null;
    return fail(
      c,
      403,
      'lane_not_allowed',
      'Purchases on this device go through the App Store.',
    );
  }
```

Add as the first line of both `POST /billing/subscribe` and `POST /billing/pack` handlers, before any Stripe call:

```ts
  const laneBlocked = requireWebLane(c);
  if (laneBlocked) return laneBlocked;
```

In `GET /billing/lane`, replace the platform default so an unrecognised platform is not silently Android:

```ts
app.get('/billing/lane', (c) => {
  const raw = c.req.query('platform');
  const platform = raw === 'android' ? 'android' : 'ios';
  const storefront = (c.req.query('storefront') ?? '').toUpperCase();
  return c.json({ lane: laneFor(platform, storefront, Deno.env.get('LANE_B') === 'on') });
});
```

- [x] **Step 4: Run the tests**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all api stripe-webhook appstore-webhook _shared
```

Expected: `134 passed | 0 failed`. User commits.

---

## Task 7: Read-only reconciliation report

**Files:**
- Create: `scripts/billing-reconcile.mjs`
- Modify: `package.json` (add the `reconcile:billing` script)

**Interfaces:**
- Consumes: `fn_paid_unfulfilled` (Task 2).
- Produces: a printed report and a non-zero exit code when anything is unfulfilled. **It changes nothing.**

- [x] **Step 1: Write the script**

Create `scripts/billing-reconcile.mjs`:

```js
#!/usr/bin/env node
// Read-only billing reconciliation. Prints applied business transactions whose
// ledger effect is missing. It NEVER writes, and it never adjusts a balance:
// any repair is a separate, owner-approved action with its own record.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/billing-reconcile.mjs [--days 7]

import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  process.exit(2);
}

const daysFlag = process.argv.indexOf('--days');
const days = daysFlag === -1 ? 7 : Number(process.argv[daysFlag + 1]);
if (!Number.isFinite(days) || days <= 0) {
  console.error('--days must be a positive number');
  process.exit(2);
}

const since = new Date(Date.now() - days * 86400 * 1000).toISOString();
const admin = createClient(url, key);

const { data, error } = await admin.rpc('fn_paid_unfulfilled', { p_since: since });
if (error) {
  console.error('reconciliation query failed:', error.message);
  process.exit(2);
}

const rows = data ?? [];
console.log(`Billing reconciliation — applied transactions since ${since}`);
console.log(`Unfulfilled: ${rows.length}`);
for (const row of rows) {
  console.log(
    [row.applied_at, row.source, row.business_txn_id, row.user_id, row.kind, `${row.credits} cr`].join('  '),
  );
}
if (rows.length > 0) {
  console.log('\nNothing was changed. Investigate each row before any correction.');
  process.exit(1);
}
```

- [x] **Step 2: Register it**

In `package.json`, add to `scripts`:

```json
    "reconcile:billing": "node scripts/billing-reconcile.mjs",
```

- [ ] **Step 3: Run it against the local stack**

```bash
cd /Users/user/IdeaProjects/vansen && SUPABASE_URL="http://127.0.0.1:54321" SUPABASE_SERVICE_ROLE_KEY="$(supabase status --output json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).SERVICE_ROLE_KEY))')" npm run reconcile:billing
```

Expected: `Unfulfilled: 0` and exit code 0.

**NOT RUN — blocked.** `supabase start` does not work on this repo (`0008_age_gate`
and `0008_credit_plans` share the version prefix `0008`), so there is no local
PostgREST for `createClient().rpc()` to reach. What was verified instead, and is
everything the script does apart from the HTTP hop: both guard clauses (missing env
→ exit 2; `--days 0` → exit 2), and that `fn_paid_unfulfilled` is executable by
`service_role` only (`authenticated` and `anon` denied). The RPC itself is covered
by SQL cases 8–10 — a healthy period reports nothing, a zero-delta renewal is not
mistaken for a missing grant, and a stuck delivery is reported then stops once
settled. First real run belongs in Task 8 Step 3, against staging.

### Finding during Task 7: a second fulfillment path was still live

`POST /billing/reconcile` in `api/app.ts` — user-callable, the fallback for a
dropped `checkout.session.completed` — was still granting through the legacy
`fn_grant_pack`, and was paying out `session.metadata.pack_credits` verbatim.
Two defects, both introduced or widened by this plan:

1. **Double grant.** `fn_apply_fulfillment` writes `stripe_ref = 'stripe:<id>'`;
   `fn_grant_pack` writes the bare `<id>`. Before P2 both paths used the bare id,
   so the `stripe_ref` UNIQUE index made them idempotent with each other. Changing
   the ref format silently removed that, and nothing else stopped the route from
   re-granting a pack the webhook had already settled.
2. **Trusting a written grant value**, which this plan forbids outright.

Fixed in two places:

- `api/app.ts`: the route now settles through `applyFulfillment` on the same
  business transaction id (the session id) as the webhook, so whichever path
  arrives second sees a replay. The grant is recomputed with `packCredits` from
  the catalogued dollar size and the plan in force; `pack_credits` is never read.
  New `catalogPackCredits` helper; covered by `api/billing_reconcile_test.ts` (9
  tests, mutation-proven — restoring the metadata read fails the catalog test).
- `0018_billing_fulfillment.sql`: `fn_apply_fulfillment` now also refuses money
  the PRE-P2 path already credited, matching `stripe_ref` against the bare
  `p_txn_id` (legacy stripe packs) and `'iap:' || p_txn_id` (legacy Apple
  grants), returning `replay` with reason `legacy_ledger_ref`. Without this,
  every pre-P2 pack and Apple grant was re-grantable once. SQL case 11 covers
  it; it failed against the unpatched function.

This makes the plan's **known carry-forward** better than written: `fn_grant_pack`
now genuinely has no callers, and neither does `fn_cycle_reset` — its two
remaining mentions are comments, and the one in `app.ts` is now stale. Both stay
in place until P9 confirms no deployed function version references them.

- [x] **Step 4: Run every suite once more**

```bash
cd /Users/user/IdeaProjects/vansen && npm test -- --watch=false && cd supabase/functions && deno test --allow-all _shared api stripe-webhook appstore-webhook && cd .. && psql "$VANSEN_LOCAL_DB" -v ON_ERROR_STOP=1 -f tests/billing_transactions.sql && ./tests/billing_concurrency.sh
```

Expected: vitest `242 passed`; deno `134 passed`; SQL clean; `OK: concurrent delivery granted once`. User commits.

---

## Task 8: Test-mode end-to-end verification

This task runs no new code. It is the manual evidence that must exist before the exit criteria are claimed, and its results belong in the P9 release runbook.

**STATUS: BLOCKED — not run.** No staging project exists, and the plan is explicit
that a test-mode webhook must not be pointed at production data. Step 1 (the log
skeleton) is done: `docs/superpowers/plans/2026-09-20-billing-verification-log.md`,
with every row recorded as **not run** plus the reason, and two rows added for the
`POST /billing/reconcile` path found above. Steps 2–3 wait on the P9 staging deploy.

**Prerequisite:** Stripe test keys and a test-mode webhook endpoint pointed at the deployed `stripe-webhook` function. Apple sandbox for the IAP half. Deploying to a staging project is a P9 step; if no staging project exists, stop and tell the user — do not point a test-mode webhook at production data.

- [x] **Step 1: Record the scenario matrix**

Create `docs/superpowers/plans/2026-09-20-billing-verification-log.md` with a table to fill in, one row per scenario and columns for date, actor, expected, observed, and evidence link:

| Scenario | Expected |
|---|---|
| First subscription, launch coupon | Charged $10/$25, granted the full 1500/3750 |
| Renewal invoice | Plan bucket snaps back to the full grant |
| Renewal replay (resend the same event from the Stripe dashboard) | No second grant; spent credits unchanged |
| Pack purchase | Pack bucket rises by the catalogued amount |
| Pack replay | No second grant |
| Upgrade Studio → Pro, `when=now` | Plan bucket tops up to 3750, never drops |
| Downgrade Pro → Studio at renewal | Grant follows the new plan at the next invoice, not immediately |
| Cancellation | Status `canceled`, access until period end, no new grant |
| Out-of-order delivery (resend an old invoice after a new one) | Refused with `stale_period`, entitlement unchanged |
| Apple sandbox initial buy | One grant, keyed on the transaction id |
| Apple sandbox renewal replay | No second grant |
| Apple sandbox refund | Clawback of exactly the original amount |
| `/iap/verify` during a forced RPC outage | HTTP 503 `retry_later`, no partial grant, retry succeeds |

- [ ] **Step 2: Run every row and fill the log**

For each row, note the resulting `billing_transactions` row and `ledger_entries` rows. Any scenario that cannot be run (for example Apple sandbox without a provisioned app) is recorded as **not run** with the reason — never as passing.

- [ ] **Step 3: Run the reconciliation report against the staging project after the matrix**

```bash
cd /Users/user/IdeaProjects/vansen && npm run reconcile:billing -- --days 1
```

Expected: `Unfulfilled: 0`. A non-zero result blocks the exit criteria. User commits the log.

---

## Exit criteria for P2

- [~] Replaying any Stripe or Apple delivery grants exactly once — **proven by the SQL suite** (cases 1–2, 5, 11) and the webhook tests; the test-mode resend half is blocked with Task 8.
- [x] Two simultaneous deliveries of the same invoice produce one ledger entry and one applied transaction (`billing_concurrency.sh`).
- [x] A failure at any point leaves no marker that would cause the retry to be skipped; the retry succeeds and grants once.
- [x] A launch-coupon invoice grants the full plan credits, matching `vansen.md` §5 (D1).
- [x] A late delivery of an older billing period is refused with `stale_period` and never moves entitlement backwards.
- [x] A pack amount mismatch answers 500 and leaves no consumed event id.
- [x] An iOS client in a non-lane-A storefront, or with no storefront header, cannot start a Stripe checkout.
- [x] `POST /iap/verify` answers `applied`, `already_applied`, or HTTP 503 `retry_later` — never a success that hides a lost grant.
- [~] `npm run reconcile:billing` reports zero unfulfilled transactions and has changed nothing — guards and grants verified; the run itself is blocked with Task 7 Step 3 / Task 8 Step 3.
- [x] `deno test --allow-all _shared api stripe-webhook appstore-webhook` reports **152 passing** (plan estimated 134; Task 7 added 9 reconcile-route tests); `npm test -- --watch=false` reports **246 passing** (plan estimated 242).

**Known carry-forward:** `fn_cycle_reset` and `fn_grant_pack` still exist and are still granted to `service_role`; nothing calls them after this plan. Leave them in place until P9 confirms no deployed function references them, then drop them in a dedicated migration — dropping a function that a still-deployed older function version calls would break fulfillment mid-rollout.
