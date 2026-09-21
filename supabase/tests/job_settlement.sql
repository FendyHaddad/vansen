-- One terminal transition per generation, under a real race.
-- LOCAL DATABASE ONLY. See supabase/tests/upload_ownership.sql for the recipe.
begin;

do $$
declare
  v_user uuid := 'aaaaaaaa-0000-4000-8000-000000000001';
  v_gen uuid; v_job uuid; v_first jsonb; v_second jsonb; v_refunds int;
begin
  insert into auth.users (id, email) values (v_user, 'settle@example.com') on conflict do nothing;
  insert into public.profiles (id, birth_date) values (v_user, '1990-01-01') on conflict do nothing;

  insert into public.generations
    (user_id, kind, family_id, family_name, op, prompt, settings,
     price_credits, charged_plan, charged_pack, status, media_url)
  values (v_user, 'image', 'flux', 'FLUX', 'generate', 'p', '{}'::jsonb,
          40, 40, 0, 'pending', '')
  returning id into v_gen;

  insert into public.jobs (generation_id, user_id, provider)
  values (v_gen, v_user, 'fal') returning id into v_job;

  -- 1. A success and a failure both try to settle. Exactly one wins.
  v_first := public.fn_settle_job(v_job, 'done', 'u/g.png', 'supabase', '{}'::jsonb, null);
  v_second := public.fn_settle_job(v_job, 'failed', null, null, '{}'::jsonb, 'cancelled');
  assert (v_first->>'settled')::boolean, 'first settlement must win';
  assert not (v_second->>'settled')::boolean, 'second settlement must lose';
  assert v_second->>'previous' = 'done', 'the loser must be told what won';
  assert (select status from public.generations where id = v_gen) = 'done';

  -- 2. The loser refunded nothing.
  select count(*) into v_refunds from public.ledger_entries
    where user_id = v_user and type = 'refund';
  assert v_refunds = 0, format('a won-done job must not refund, got %s entries', v_refunds);
end $$;

do $$
declare
  v_user uuid := 'aaaaaaaa-0000-4000-8000-000000000002';
  v_gen uuid; v_job uuid; v_out jsonb; v_total int;
begin
  insert into auth.users (id, email) values (v_user, 'refund@example.com') on conflict do nothing;
  insert into public.profiles (id, birth_date) values (v_user, '1990-01-01') on conflict do nothing;
  insert into public.generations
    (user_id, kind, family_id, family_name, op, prompt, settings,
     price_credits, charged_plan, charged_pack, status, media_url)
  values (v_user, 'video', 'kling', 'Kling', 'generate', 'p', '{}'::jsonb,
          100, 60, 40, 'pending', '')
  returning id into v_gen;
  insert into public.jobs (generation_id, user_id, provider)
  values (v_gen, v_user, 'fal') returning id into v_job;

  -- 3. A failure refunds both buckets, exactly once, however often it is called.
  v_out := public.fn_settle_job(v_job, 'failed', null, null, '{}'::jsonb, 'timeout');
  assert (v_out->>'refunded')::int = 100, format('expected 100 refunded, got %s', v_out->>'refunded');
  perform public.fn_settle_job(v_job, 'failed', null, null, '{}'::jsonb, 'timeout');
  perform public.fn_fail_job(v_job, 'timeout');
  select coalesce(sum(amount_credits), 0) into v_total from public.ledger_entries
    where user_id = v_user and type = 'refund';
  assert v_total = 100, format('refunded more than once: %s', v_total);

  -- 4. Exactly one failure notification was queued.
  assert (select count(*) from public.notification_outbox
          where generation_id = v_gen and event = 'generation_failed') = 1,
    'one failure, one notification';
end $$;

-- 5. 'done' with no verified media is refused outright: that is the exact shape
-- of the bug this function replaces — a paid row pointing at nothing.
do $$
declare
  v_user uuid := 'aaaaaaaa-0000-4000-8000-000000000004';
  v_gen uuid; v_job uuid; v_raised text := '';
begin
  insert into auth.users (id, email) values (v_user, 'nomedia@example.com') on conflict do nothing;
  insert into public.profiles (id, birth_date) values (v_user, '1990-01-01') on conflict do nothing;
  insert into public.generations
    (user_id, kind, family_id, family_name, op, prompt, settings,
     price_credits, charged_plan, charged_pack, status, media_url)
  values (v_user, 'image', 'flux', 'FLUX', 'generate', 'p', '{}'::jsonb, 40, 40, 0, 'pending', '')
  returning id into v_gen;
  insert into public.jobs (generation_id, user_id, provider)
  values (v_gen, v_user, 'fal') returning id into v_job;

  begin
    perform public.fn_settle_job(v_job, 'done', null, null, '{}'::jsonb, null);
  exception when others then v_raised := SQLERRM;
  end;
  assert v_raised = 'verified_media_required', format('expected a refusal, got "%s"', v_raised);
  assert (select status from public.generations where id = v_gen) = 'pending',
    'a refused settlement must leave the job pending';

  -- An unknown storage backend is refused for the same reason.
  v_raised := '';
  begin
    perform public.fn_settle_job(v_job, 'done', 'u/g.png', 'dropbox', '{}'::jsonb, null);
  exception when others then v_raised := SQLERRM;
  end;
  assert v_raised = 'verified_media_required', format('expected a refusal, got "%s"', v_raised);
end $$;

-- 6. A cancel is a refund WITHOUT a "your generation failed" notification —
-- the customer asked for it, so telling them it failed is noise.
do $$
declare
  v_user uuid := 'aaaaaaaa-0000-4000-8000-000000000005';
  v_gen uuid; v_job uuid; v_out jsonb;
begin
  insert into auth.users (id, email) values (v_user, 'cancel@example.com') on conflict do nothing;
  insert into public.profiles (id, birth_date) values (v_user, '1990-01-01') on conflict do nothing;
  insert into public.generations
    (user_id, kind, family_id, family_name, op, prompt, settings,
     price_credits, charged_plan, charged_pack, status, media_url)
  values (v_user, 'image', 'flux', 'FLUX', 'generate', 'p', '{}'::jsonb, 40, 40, 0, 'pending', '')
  returning id into v_gen;
  insert into public.jobs (generation_id, user_id, provider)
  values (v_gen, v_user, 'fal') returning id into v_job;

  v_out := public.fn_settle_job(v_job, 'failed', null, null, '{}'::jsonb, 'cancelled');
  assert (v_out->>'refunded')::int = 40, 'a cancel still refunds';
  assert (select failure_code from public.generations where id = v_gen) = 'cancelled';
  assert (select count(*) from public.notification_outbox where generation_id = v_gen) = 0,
    'a cancel the customer asked for must not queue a failure notification';
end $$;

rollback;
