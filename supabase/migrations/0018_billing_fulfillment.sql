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
--
-- (written 2026-09-20; apply AFTER 0016_video.sql and 0017_upload_registry.sql)
-- Deployed inventory as of 2026-09-21: 0017 IS applied to bnorhcxhvxydkgvcxjad;
-- 0016_video.sql is NOT. This file is additive and independent of 0016.

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

create index billing_transactions_user_idx
  on public.billing_transactions (user_id, applied_at desc);

alter table public.billing_transactions enable row level security;

-- Verified-receipt inbox. Written BEFORE the money transaction and resolved
-- after it, so a rollback leaves a retryable row rather than a committed
-- applied marker. Its existence never suppresses a retry — only
-- billing_transactions does that.
create table public.billing_deliveries (
  source text not null check (source in ('stripe', 'apple')),
  event_id text not null,
  business_txn_id text not null,
  user_id uuid not null,
  verified_at timestamptz not null default now(),
  attempts int not null default 0,
  last_error text,
  next_attempt_at timestamptz not null default now(),
  resolved_at timestamptz,
  primary key (source, event_id)
);

create index billing_deliveries_pending_idx
  on public.billing_deliveries (next_attempt_at)
  where resolved_at is null;

alter table public.billing_deliveries enable row level security;

-- Small helper so the result shape is written once.
create or replace function public.fn_credits_json(p_user uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('plan', bal.plan_credits, 'pack', bal.pack_credits)
  from public.fn_balances(p_user) bal;
$$;

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

  -- Pre-P2 grants keyed the ledger on the bare Stripe session id (packs) or
  -- 'iap:<transaction>' (Apple). This function writes 'stripe:'/'apple:' refs,
  -- so the UNIQUE index that used to make the old and new paths idempotent with
  -- each other no longer sees them as the same row. Money the old path already
  -- credited is settled, never granted a second time.
  if p_kind in ('pack_grant', 'subscription_grant')
     and exists (
       select 1 from public.ledger_entries
       where stripe_ref in (p_txn_id, 'iap:' || p_txn_id)
     )
  then
    v_result := jsonb_build_object(
      'applied', false, 'replay', true, 'reason', 'legacy_ledger_ref',
      'credits', public.fn_credits_json(p_user), 'entitlement', null
    );
    insert into public.billing_transactions
      (source, business_txn_id, user_id, kind, plan, credits, period_end, event_at, result)
    values (p_source, p_txn_id, p_user, p_kind, p_plan, 0, p_period_end, p_event_at, v_result);
    return v_result;
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
    -- plan/status are NOT NULL: a revoke that names neither must fall back to
    -- what is already stored rather than fail the whole money transaction.
    insert into public.subscriptions (
      user_id, plan, status, current_period_end, stripe_subscription_id,
      iap_original_transaction_id, cancel_reason, updated_at
    ) values (
      p_user,
      coalesce(p_entitlement->>'plan', v_subscription.plan, p_plan, 'free'),
      coalesce(p_entitlement->>'status', v_subscription.status, 'inactive'),
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
      pending_plan = case when p_clear_pending then null else subscriptions.pending_plan end,
      pending_at = case when p_clear_pending then null else subscriptions.pending_at end,
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

-- Read-only reconciliation: applied business transactions whose ledger effect
-- is missing, and verified deliveries that never reached a transaction at all.
-- Never repairs.
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
  select distinct d.source, d.business_txn_id, d.user_id, 'pending'::text, 0, d.verified_at
  from public.billing_deliveries d
  where d.verified_at >= p_since and d.resolved_at is null and d.next_attempt_at <= now()
    and not exists (
      select 1 from public.billing_transactions t
      where t.source = d.source and t.business_txn_id = d.business_txn_id
    );
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
