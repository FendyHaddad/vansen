-- Integration proof for the billing fulfillment transaction.
-- LOCAL DATABASE ONLY. Every statement runs inside one transaction that is
-- rolled back at the end, so this file never leaves rows behind — but it
-- creates and destroys users, so it must never be pointed at production.
--
-- How to run: see the header of supabase/tests/upload_ownership.sql for the
-- local-stack recipe (`supabase start` does not work on this repo — 0008_age_gate
-- and 0008_credit_plans share the version prefix 0008).
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

-- 9. A valid ZERO-DELTA reset is not a missing grant.
do $$
declare
  v_user uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; v_rows int;
begin
  insert into auth.users (id, email) values (v_user, 'zero@example.com') on conflict do nothing;
  insert into public.profiles (id, birth_date) values (v_user, '1990-01-01') on conflict do nothing;
  -- First cycle grants 1500; the second, with the bucket untouched, moves nothing.
  perform public.fn_apply_fulfillment('stripe','in_z1',v_user,'subscription_grant','studio',1500,
    now() + interval '30 days', now(), null, false, false);
  perform public.fn_apply_fulfillment('stripe','in_z2',v_user,'subscription_grant','studio',1500,
    now() + interval '60 days', now(), null, false, false);
  select count(*) into v_rows from public.fn_paid_unfulfilled(now() - interval '1 day')
    where business_txn_id = 'in_z2';
  assert v_rows = 0, 'a zero-delta renewal must not look like a missing grant';
end $$;

-- 10. A verified delivery that never reached a transaction IS reported.
do $$
declare
  v_user uuid := 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; v_rows int; v_kind text;
begin
  insert into auth.users (id, email) values (v_user, 'stuck@example.com') on conflict do nothing;
  insert into public.profiles (id, birth_date) values (v_user, '1990-01-01') on conflict do nothing;
  insert into public.billing_deliveries (source, event_id, business_txn_id, user_id, attempts, last_error)
    values ('stripe','evt_stuck','in_stuck',v_user,3,'connection reset');
  select count(*), min(kind) into v_rows, v_kind
    from public.fn_paid_unfulfilled(now() - interval '1 day')
    where business_txn_id = 'in_stuck';
  assert v_rows = 1, format('a stuck delivery must be reported, got %s rows', v_rows);
  assert v_kind = 'pending', format('stuck deliveries report as pending, got %s', v_kind);

  -- Once the money lands, it stops being reported.
  perform public.fn_apply_fulfillment('stripe','in_stuck',v_user,'pack_grant',null,1000,
    null, now(), null, false, false);
  select count(*) into v_rows from public.fn_paid_unfulfilled(now() - interval '1 day')
    where business_txn_id = 'in_stuck';
  assert v_rows = 0, 'a settled delivery must stop being reported';
end $$;

-- 11. Money credited by the PRE-P2 path is never granted a second time.
-- Old refs were the bare session id (stripe packs) and 'iap:<txn>' (apple);
-- this function writes 'stripe:'/'apple:', so without the legacy guard the
-- UNIQUE index would not recognise the row and the customer would be paid twice.
do $$
declare
  v_user uuid := 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  v_res jsonb; v_pack int; v_before int;
begin
  insert into auth.users (id, email) values (v_user, 'legacy@example.com') on conflict do nothing;
  insert into public.profiles (id, birth_date) values (v_user, '1990-01-01') on conflict do nothing;

  -- A pack the old fn_grant_pack already credited, keyed on the bare session id.
  insert into public.ledger_entries (user_id, type, bucket, amount_credits, note, stripe_ref)
    values (v_user, 'pack_purchase', 'pack', 1000, 'Credit pack', 'cs_legacy_1');
  select bal.pack_credits into v_before from public.fn_balances(v_user) bal;

  v_res := public.fn_apply_fulfillment('stripe','cs_legacy_1',v_user,'pack_grant',null,1000,
    null, now(), null, false, false);
  assert not (v_res->>'applied')::boolean, 'a legacy-credited pack must not apply again';
  assert (v_res->>'replay')::boolean, 'a legacy-credited pack reads as a replay';
  assert v_res->>'reason' = 'legacy_ledger_ref', format('unexpected reason %s', v_res->>'reason');
  select bal.pack_credits into v_pack from public.fn_balances(v_user) bal;
  assert v_pack = v_before, format('balance moved: %s -> %s', v_before, v_pack);

  -- The Apple half: legacy refs carried the 'iap:' prefix.
  insert into public.ledger_entries (user_id, type, bucket, amount_credits, note, stripe_ref)
    values (v_user, 'cycle_reset', 'plan', 1500, 'Cycle renewal grant', 'iap:tx_legacy_1');
  v_res := public.fn_apply_fulfillment('apple','tx_legacy_1',v_user,'subscription_grant','studio',1500,
    now() + interval '30 days', now(), null, false, false);
  assert not (v_res->>'applied')::boolean, 'a legacy iap grant must not apply again';
  assert v_res->>'reason' = 'legacy_ledger_ref', format('unexpected reason %s', v_res->>'reason');

  -- And an untouched session is still grantable.
  v_res := public.fn_apply_fulfillment('stripe','cs_fresh_1',v_user,'pack_grant',null,1000,
    null, now(), null, false, false);
  assert (v_res->>'applied')::boolean, 'an ungranted session must still apply';
end $$;

rollback;
