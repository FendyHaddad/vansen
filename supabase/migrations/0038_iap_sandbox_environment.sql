-- 0038: App Store sandbox purchases are granted and recorded as sandbox.
--
-- Owner decision 2026-09-24. App Review and TestFlight buy in Apple's sandbox
-- against the production server. Per Apple's guidance the backend verifies
-- against production first and, when Apple says the payload is a sandbox one,
-- against sandbox, and grants. Those grants are real credits for the reviewer
-- but not money: billing_transactions.environment records which is which, and
-- anything that reports revenue or paying customers leaves 'sandbox' out.
--
-- Dedupe is unchanged: unique (source, business_txn_id). The environment is
-- Apple-signed, never client-claimed, so no redelivery can "claim the other
-- environment" for an id it already used. Environment stays out of the key
-- because Apple transaction ids do not collide across environments in
-- practice; if that ever changed, the second delivery would read as a replay
-- of the first (fn_apply_fulfillment's replay branch, unchanged here).
--
-- Deploy order: this migration first. It is backward compatible with the
-- deployed functions (p_environment defaults to 'production'), and the new
-- functions omit p_environment for production money, so only sandbox grants
-- depend on it.
--
-- Written 2026-09-24. NOT applied anywhere yet.

-- The table is tiny pre-launch, but a stuck billing transaction should make
-- this migration fail fast rather than queue every grant behind an
-- ACCESS EXCLUSIVE lock. Applied via `db push` or MCP, both of which wrap the
-- file in a transaction, so this is scoped to just this migration.
set local lock_timeout = '5s';

alter table public.billing_transactions
  add column environment text not null default 'production'
    check (environment in ('production', 'sandbox'));

-- Every Apple row written before this migration was bought in Apple's
-- sandbox: hosted APPLE_ENV has been "Sandbox" since 2026-07-18 (verified by
-- secret digest 2026-09-24), the sandbox-only verifier that ran until now
-- cannot accept a production payload, and production had 0 billing_transactions
-- rows on 2026-09-24. The column default above would otherwise mislabel every
-- one of them 'production' -- counting App Review/TestFlight accounts as
-- paying customers and pulling them into revenue queries. Re-tag them before
-- anything reads the new column.
update public.billing_transactions set environment = 'sandbox' where source = 'apple';

-- Stripe has a test mode, never a sandbox receipt on this project.
alter table public.billing_transactions
  add constraint billing_transactions_sandbox_is_apple
    check (environment = 'production' or source = 'apple');

comment on column public.billing_transactions.environment is
  'App Store environment of the verified receipt. sandbox = App Review / TestFlight: granted, never revenue.';

-- A new trailing parameter would leave the 11-argument version beside it,
-- and a call naming only those 11 would then match both. Replace it.
drop function public.fn_apply_fulfillment(
  text, text, uuid, text, text, int, timestamptz, timestamptz, jsonb, boolean, boolean
);

-- Body as 0018, plus p_environment written on every billing_transactions row.
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
  p_clear_pending boolean default false,
  p_environment text default 'production'
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
      (source, business_txn_id, user_id, kind, plan, credits, period_end, event_at, result, environment)
    values (p_source, p_txn_id, p_user, p_kind, p_plan, 0, p_period_end, p_event_at, v_result, p_environment);
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
      (source, business_txn_id, user_id, kind, plan, credits, period_end, event_at, result, environment)
    values (p_source, p_txn_id, p_user, p_kind, p_plan, 0, p_period_end, p_event_at, v_result, p_environment);
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
    (source, business_txn_id, user_id, kind, plan, credits, period_end, event_at, result, environment)
  values (p_source, p_txn_id, p_user, p_kind, p_plan, coalesce(p_credits, 0), p_period_end, p_event_at, v_result, p_environment);

  return v_result;
end $$;

revoke execute on function public.fn_apply_fulfillment(
  text, text, uuid, text, text, int, timestamptz, timestamptz, jsonb, boolean, boolean, text
) from public, anon, authenticated;
grant execute on function public.fn_apply_fulfillment(
  text, text, uuid, text, text, int, timestamptz, timestamptz, jsonb, boolean, boolean, text
) to service_role;

-- True when the user's entitlement is carried by an App Store SANDBOX grant:
-- the latest applied, unrefunded subscription grant (the rule
-- subscription-source.ts uses for the rail) is apple + sandbox.
create or replace function public.fn_sandbox_entitlement(p_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((
    select t.environment = 'sandbox'
    from public.billing_transactions t
    where t.user_id = p_user
      and t.kind = 'subscription_grant'
      and (t.result->>'applied')::boolean
      and t.business_txn_id not like 'refund:%'
      and not exists (
        select 1 from public.billing_transactions r
        where r.source = t.source and r.business_txn_id = 'refund:' || t.business_txn_id
      )
    order by t.period_end desc nulls last, t.applied_at desc
    limit 1
  ), false);
$$;

revoke execute on function public.fn_sandbox_entitlement(uuid) from public, anon, authenticated;
grant execute on function public.fn_sandbox_entitlement(uuid) to service_role;

-- backoffice_summary: active_subscriptions counts paying customers only, so an
-- App Review / TestFlight account carried by a sandbox grant is left out.
-- Body otherwise identical to 0008 §10. create or replace keeps the grants.
create or replace function public.backoffice_summary()
returns jsonb language sql security definer set search_path = public as $$
select jsonb_build_object(
  'users', (select count(*) from profiles),
  'users_7d', (select count(*) from profiles where created_at > now() - interval '7 days'),
  'active_subscriptions', (select count(*) from subscriptions s
                            where s.status = 'active' and not public.fn_sandbox_entitlement(s.user_id)),
  'generations_total', (select count(*) from generations),
  'generations_7d', (select count(*) from generations where created_at > now() - interval '7 days'),
  'failed_jobs_7d', (select count(*) from jobs where error is not null and updated_at > now() - interval '7 days'),
  'gen_credits_30d', coalesce((select sum(price_credits) from generations where created_at > now() - interval '30 days'), 0),
  'daily', (select coalesce(jsonb_agg(jsonb_build_object('day', d.day, 'value', coalesce(g.c, 0)) order by d.day), '[]'::jsonb)
            from (select generate_series(current_date - 29, current_date, interval '1 day')::date as day) d
            left join (select created_at::date as day, count(*) c from generations
                       where created_at > current_date - 29 group by 1) g using (day)),
  'recent', (select coalesce(jsonb_agg(jsonb_build_object('type', t, 'title', title, 'at', at, 'userId', uid) order by at desc), '[]'::jsonb)
             from (
               (select 'signup' as t, coalesce(display_name, 'New user') as title, created_at as at, id as uid
                  from profiles order by created_at desc limit 5)
               union all
               (select 'generation', coalesce(family_name, kind) || ' · ' || coalesce(op, 'create'), created_at, user_id
                  from generations order by created_at desc limit 5)
               union all
               (select 'subscription', plan || ' — ' || status, coalesce(updated_at, created_at), user_id
                  from subscriptions order by coalesce(updated_at, created_at) desc limit 5)
               union all
               (select 'error', coalesce(code, 'error') || ' · ' || coalesce(route, '?'), created_at, user_id
                  from app_errors order by created_at desc limit 5)
             ) ev)
);
$$;
