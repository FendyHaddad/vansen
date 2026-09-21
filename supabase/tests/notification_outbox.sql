-- Claiming, acking and retrying outbox rows. LOCAL DATABASE ONLY.
-- Delivery is at least once; the database side of it must be exactly once:
-- one claim per row at a time, one sent_at, and a dead letter rather than a
-- fake success once the retries are spent.
begin;

-- 1. Two drainers, one row: exactly one lease is issued.
do $$
declare
  v_user uuid := 'bbbbbbbb-0000-4000-8000-000000000001';
  v_row uuid; v_first uuid; v_second uuid; v_claims int;
begin
  insert into auth.users (id, email) values (v_user, 'outbox1@example.com') on conflict do nothing;
  insert into public.profiles (id, birth_date) values (v_user, '1990-01-01') on conflict do nothing;
  insert into public.notification_outbox (user_id, generation_id, event)
  values (v_user, null, 'generation_done') returning id into v_row;

  select count(*) into v_claims from public.fn_claim_notifications(10) where id = v_row;
  assert v_claims = 1, 'the first drainer must get the row';
  select lease_token into v_first from public.notification_outbox where id = v_row;
  assert v_first is not null, 'a claim must leave a lease token';

  -- A second drainer, while the lease is live, must see nothing.
  select count(*) into v_claims from public.fn_claim_notifications(10) where id = v_row;
  assert v_claims = 0, 'a leased row must not be claimed twice';

  -- 2. An expired lease is claimable again, and the OLD token can no longer ack.
  update public.notification_outbox set lease_until = now() - interval '1 minute' where id = v_row;
  select count(*) into v_claims from public.fn_claim_notifications(10) where id = v_row;
  assert v_claims = 1, 'an expired lease must be reclaimable';
  assert not public.fn_ack_notification(v_row, v_first, null),
    'a stale lease token must not be able to mark the row sent';
  assert (select sent_at from public.notification_outbox where id = v_row) is null,
    'a stale ack must not mark anything sent';

  -- An expired lease cannot ack even with the RIGHT token: while it was
  -- expired another drainer was free to claim the row, so this delivery no
  -- longer owns it.
  select lease_token into v_second from public.notification_outbox where id = v_row;
  update public.notification_outbox set lease_until = now() - interval '1 second' where id = v_row;
  assert not public.fn_ack_notification(v_row, v_second, null),
    'an expired lease must not ack, however right its token';
  assert (select sent_at from public.notification_outbox where id = v_row) is null;
end $$;

-- 3. A successful ack marks it sent once and it never comes back.
do $$
declare
  v_user uuid := 'bbbbbbbb-0000-4000-8000-000000000002';
  v_row uuid; v_token uuid; v_claims int;
begin
  insert into auth.users (id, email) values (v_user, 'outbox2@example.com') on conflict do nothing;
  insert into public.profiles (id, birth_date) values (v_user, '1990-01-01') on conflict do nothing;
  insert into public.notification_outbox (user_id, generation_id, event)
  values (v_user, null, 'generation_done') returning id into v_row;

  perform public.fn_claim_notifications(10);
  select lease_token into v_token from public.notification_outbox where id = v_row;
  assert public.fn_ack_notification(v_row, v_token, null), 'a live token must ack';
  assert (select sent_at from public.notification_outbox where id = v_row) is not null;
  assert not public.fn_ack_notification(v_row, v_token, null), 'a sent row must not ack twice';

  update public.notification_outbox set next_run_at = now() - interval '1 hour' where id = v_row;
  select count(*) into v_claims from public.fn_claim_notifications(10) where id = v_row;
  assert v_claims = 0, 'a sent row must never be claimed again';
end $$;

-- 4. A failed delivery stays unsent, backs off, and eventually dead-letters
--    instead of pretending it was delivered.
do $$
declare
  v_user uuid := 'bbbbbbbb-0000-4000-8000-000000000003';
  v_row uuid; v_token uuid; v_claims int;
begin
  insert into auth.users (id, email) values (v_user, 'outbox3@example.com') on conflict do nothing;
  insert into public.profiles (id, birth_date) values (v_user, '1990-01-01') on conflict do nothing;
  insert into public.notification_outbox (user_id, generation_id, event)
  values (v_user, null, 'generation_failed') returning id into v_row;

  perform public.fn_claim_notifications(10);
  select lease_token into v_token from public.notification_outbox where id = v_row;
  assert public.fn_ack_notification(v_row, v_token, 'fcm_unavailable'), 'a failure must still ack the lease';
  assert (select sent_at from public.notification_outbox where id = v_row) is null,
    'a failed delivery is not a delivery';
  assert (select last_error from public.notification_outbox where id = v_row) = 'fcm_unavailable';
  assert (select next_run_at from public.notification_outbox where id = v_row) > now(),
    'a failed delivery must back off before the next attempt';
  assert (select dead_letter_at from public.notification_outbox where id = v_row) is null,
    'one failure is not a dead letter';

  -- Spend the retries.
  for i in 1..5 loop
    update public.notification_outbox set next_run_at = now() - interval '1 hour' where id = v_row;
    perform public.fn_claim_notifications(10);
    select lease_token into v_token from public.notification_outbox where id = v_row;
    perform public.fn_ack_notification(v_row, v_token, 'fcm_unavailable');
  end loop;

  assert (select dead_letter_at from public.notification_outbox where id = v_row) is not null,
    'exhausted retries must dead-letter';
  assert (select sent_at from public.notification_outbox where id = v_row) is null,
    'a dead letter must never look delivered';
  update public.notification_outbox set next_run_at = now() - interval '1 hour' where id = v_row;
  select count(*) into v_claims from public.fn_claim_notifications(10) where id = v_row;
  assert v_claims = 0, 'a dead letter must not be claimed again';
end $$;

-- 5. A user cancellation refunds without queueing a "your generation failed"
--    notification: they asked for it, so telling them it failed is noise.
do $$
declare
  v_user uuid := 'bbbbbbbb-0000-4000-8000-000000000004';
  v_gen uuid; v_job uuid;
begin
  insert into auth.users (id, email) values (v_user, 'outbox4@example.com') on conflict do nothing;
  insert into public.profiles (id, birth_date) values (v_user, '1990-01-01') on conflict do nothing;
  insert into public.generations
    (user_id, kind, family_id, family_name, op, prompt, settings,
     price_credits, charged_plan, charged_pack, status, media_url)
  values (v_user, 'image', 'flux', 'FLUX', 'generate', 'p', '{}'::jsonb, 40, 40, 0, 'pending', '')
  returning id into v_gen;
  insert into public.jobs (generation_id, user_id, provider)
  values (v_gen, v_user, 'fal') returning id into v_job;

  perform public.fn_settle_job(v_job, 'failed', null, null, '{}'::jsonb, 'cancelled', 'pending', 'cancelled');
  assert (select count(*) from public.notification_outbox where generation_id = v_gen) = 0,
    'a cancellation must not queue a failure notification';
end $$;

-- 6. The claim is bounded and ordered oldest first.
do $$
declare
  v_user uuid := 'bbbbbbbb-0000-4000-8000-000000000005';
  v_oldest uuid; v_claimed uuid[];
begin
  insert into auth.users (id, email) values (v_user, 'outbox5@example.com') on conflict do nothing;
  insert into public.profiles (id, birth_date) values (v_user, '1990-01-01') on conflict do nothing;
  insert into public.notification_outbox (user_id, event, created_at)
  values (v_user, 'generation_done', now() - interval '2 hours') returning id into v_oldest;
  insert into public.notification_outbox (user_id, event, created_at)
  values (v_user, 'generation_done', now() - interval '1 hour');
  insert into public.notification_outbox (user_id, event, created_at)
  values (v_user, 'generation_done', now());

  select array_agg(id) into v_claimed from public.fn_claim_notifications(2);
  assert array_length(v_claimed, 1) = 2, 'the limit must be respected';
  assert v_claimed[1] = v_oldest, 'the oldest unsent row is delivered first';
end $$;

rollback;
