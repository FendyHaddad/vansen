-- Reservation: one transaction that charges, creates the generation, its job
-- and its expense record — or leaves nothing behind. LOCAL DATABASE ONLY.
begin;

-- Seeded accounts: each block funds its own user so balances are known.
create or replace function pg_temp.seed_user(p_user uuid, p_email text, p_plan_credits int)
returns void language plpgsql as $$
begin
  insert into auth.users (id, email) values (p_user, p_email) on conflict do nothing;
  insert into public.profiles (id, birth_date) values (p_user, '1990-01-01') on conflict do nothing;
  insert into public.subscriptions (user_id, plan, status, current_period_end)
  values (p_user, 'pro', 'active', now() + interval '30 days')
  on conflict (user_id) do update set plan = 'pro', status = 'active';
  insert into public.ledger_entries (user_id, type, bucket, amount_credits, note)
  values (p_user, 'cycle_reset', 'plan', p_plan_credits, 'test seed ' || p_user::text);
end $$;

create or replace function pg_temp.items(p_count int, p_kind text, p_credits int)
returns jsonb language sql as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'kind', p_kind, 'familyId', 'flux', 'familyName', 'FLUX', 'op', 'generate',
    'prompt', 'a cat', 'settings', '{}'::jsonb, 'priceCredits', p_credits
  )), '[]'::jsonb) from generate_series(1, p_count);
$$;

create or replace function pg_temp.quote(p_credits int, p_usd numeric, p_provider text default 'fal')
returns jsonb language sql as $$
  select jsonb_build_object(
    'provider', p_provider, 'chargeType', 'generate', 'unitCredits', p_credits,
    'unitProviderCostUsd', p_usd, 'catalogVersion', '2026-09-20.2', 'quoteVersion', 1
  );
$$;

-- The payload carries the request snapshot. 0023 made it mandatory — a
-- generation without one can never be retried and there is no way to add it
-- afterwards — so every reservation here must supply a real one.
create or replace function pg_temp.payload()
returns jsonb language sql as $$
  select jsonb_build_object('snapshot', jsonb_build_object(
    'version', 1, 'catalogVersion', '2026-09-20.2',
    'prompt', 'a cat', 'settings', '{}'::jsonb
  ));
$$;

-- 1. A replay returns the ORIGINAL ids, charges once, creates one submission.
do $$
declare
  v_user uuid := 'cccccccc-0000-4000-8000-000000000001';
  v_key uuid := 'dddddddd-0000-4000-8000-000000000001';
  v_first jsonb; v_replay jsonb; v_spend int;
begin
  perform pg_temp.seed_user(v_user, 'reserve1@example.com', 1000);

  v_first := public.fn_reserve_generation(
    v_user, v_key, 'hash-1', pg_temp.items(1, 'image', 40), pg_temp.quote(40, 0.012), pg_temp.payload());
  v_replay := public.fn_reserve_generation(
    v_user, v_key, 'hash-1', pg_temp.items(1, 'image', 40), pg_temp.quote(40, 0.012), pg_temp.payload());

  assert v_first = v_replay, 'replay must return the original persisted IDs';
  assert (select count(*) from public.submissions
          where user_id = v_user and idempotency_key = v_key) = 1;
  assert (select count(*) from public.generations where user_id = v_user) = 1,
    'a replay must not create a second generation';
  select coalesce(-sum(amount_credits), 0) into v_spend from public.ledger_entries
    where user_id = v_user and type = 'generate';
  assert v_spend = 40, format('charged %s, expected 40 exactly once', v_spend);
  assert (select count(*) from public.jobs where user_id = v_user) =
         jsonb_array_length(v_first->'jobIds');
  assert not exists (
    select 1 from public.generations g left join public.jobs j on j.generation_id = g.id
    where g.user_id = v_user and g.status = 'pending' and j.id is null
  ), 'reservation left an orphan';
  assert (select state from public.jobs where user_id = v_user) = 'ready';
end $$;

-- 2. The same key with a different body is a client bug, not a replay.
do $$
declare
  v_user uuid := 'cccccccc-0000-4000-8000-000000000002';
  v_key uuid := 'dddddddd-0000-4000-8000-000000000002';
  v_raised text := '';
begin
  perform pg_temp.seed_user(v_user, 'reserve2@example.com', 1000);
  perform public.fn_reserve_generation(
    v_user, v_key, 'hash-a', pg_temp.items(1, 'image', 40), pg_temp.quote(40, 0.012), pg_temp.payload());
  begin
    perform public.fn_reserve_generation(
      v_user, v_key, 'hash-b', pg_temp.items(1, 'image', 40), pg_temp.quote(40, 0.012), pg_temp.payload());
  exception when others then v_raised := sqlerrm;
  end;
  assert v_raised = 'idempotency_conflict', format('expected conflict, got "%s"', v_raised);
  assert (select count(*) from public.generations where user_id = v_user) = 1,
    'a conflicting replay must not charge or generate';
end $$;

-- 3. A failed job insert rolls the whole reservation back: no charged
--    generation without a job, which is the defect this replaces.
do $$
declare
  v_user uuid := 'cccccccc-0000-4000-8000-000000000003';
  v_key uuid := 'dddddddd-0000-4000-8000-000000000003';
  v_raised text := '';
begin
  perform pg_temp.seed_user(v_user, 'reserve3@example.com', 1000);
  create or replace function pg_temp.boom() returns trigger language plpgsql as $t$
  begin
    raise exception 'job insert exploded';
  end $t$;
  create trigger pg_temp_boom before insert on public.jobs
    for each row execute function pg_temp.boom();
  begin
    perform public.fn_reserve_generation(
      v_user, v_key, 'hash-3', pg_temp.items(1, 'image', 40), pg_temp.quote(40, 0.012), pg_temp.payload());
  exception when others then v_raised := sqlerrm;
  end;
  drop trigger pg_temp_boom on public.jobs;

  assert v_raised <> '', 'the failure must surface, not be swallowed';
  assert (select count(*) from public.generations where user_id = v_user) = 0, 'generation survived';
  assert (select count(*) from public.ledger_entries
          where user_id = v_user and type = 'generate') = 0, 'charge survived';
  assert (select count(*) from public.submissions where user_id = v_user) = 0, 'submission survived';
  assert (select count(*) from public.provider_expenses where user_id = v_user) = 0, 'expense survived';
end $$;

-- 4. A batch of 3 books THREE expense rows of one unit each — not unit x batch
--    per row, which would triple-count the budget.
do $$
declare
  v_user uuid := 'cccccccc-0000-4000-8000-000000000004';
  v_key uuid := 'dddddddd-0000-4000-8000-000000000004';
  v_out jsonb; v_sum numeric; v_rows int;
begin
  perform pg_temp.seed_user(v_user, 'reserve4@example.com', 1000);
  v_out := public.fn_reserve_generation(
    v_user, v_key, 'hash-4', pg_temp.items(3, 'image', 40), pg_temp.quote(40, 0.012), pg_temp.payload());
  assert jsonb_array_length(v_out->'generationIds') = 3;
  select count(*), coalesce(sum(reserved_usd), 0) into v_rows, v_sum
    from public.provider_expenses where user_id = v_user;
  assert v_rows = 3, format('expected 3 expense rows, got %s', v_rows);
  assert v_sum = 0.036, format('expected 0.036 reserved, got %s', v_sum);
  assert (select coalesce(-sum(amount_credits), 0) from public.ledger_entries
          where user_id = v_user and type = 'generate') = 120;
end $$;

-- 5. Charge attribution: plan first, then pack, exactly as fn_charge_and_generate
--    has always done — the reservation must not re-derive it.
do $$
declare
  v_user uuid := 'cccccccc-0000-4000-8000-000000000005';
  v_key uuid := 'dddddddd-0000-4000-8000-000000000005';
begin
  perform pg_temp.seed_user(v_user, 'reserve5@example.com', 30);
  insert into public.ledger_entries (user_id, type, bucket, amount_credits, note)
  values (v_user, 'pack_purchase', 'pack', 100, 'test pack seed');
  perform public.fn_reserve_generation(
    v_user, v_key, 'hash-5', pg_temp.items(1, 'image', 40), pg_temp.quote(40, 0.012), pg_temp.payload());
  assert (select charged_plan from public.generations where user_id = v_user) = 30;
  assert (select charged_pack from public.generations where user_id = v_user) = 10;
end $$;

-- 6. The video cap counts work that has been reserved but not yet dispatched.
do $$
declare
  v_user uuid := 'cccccccc-0000-4000-8000-000000000006';
  v_raised text := '';
  i int;
begin
  perform pg_temp.seed_user(v_user, 'reserve6@example.com', 10000);
  for i in 1..3 loop
    perform public.fn_reserve_generation(
      v_user, gen_random_uuid(), 'hash-v' || i, pg_temp.items(1, 'video', 100),
      pg_temp.quote(100, 0.6), pg_temp.payload());
  end loop;
  begin
    perform public.fn_reserve_generation(
      v_user, gen_random_uuid(), 'hash-v4', pg_temp.items(1, 'video', 100),
      pg_temp.quote(100, 0.6), pg_temp.payload());
  exception when others then v_raised := sqlerrm;
  end;
  assert v_raised = 'too_many_jobs', format('expected too_many_jobs, got "%s"', v_raised);
  assert (select count(*) from public.generations
          where user_id = v_user and kind = 'video') = 3;
end $$;

-- 7. A refunded job's provider cost still counts against the daily budget: the
--    money left our account whatever we told the customer.
do $$
declare
  v_user uuid := 'cccccccc-0000-4000-8000-000000000007';
  v_out jsonb; v_job uuid; v_raised text := '';
begin
  perform pg_temp.seed_user(v_user, 'reserve7@example.com', 100000);
  -- One reservation that eats almost the whole daily budget, then refunded.
  v_out := public.fn_reserve_generation(
    v_user, gen_random_uuid(), 'hash-7a', pg_temp.items(1, 'video', 100),
    pg_temp.quote(100, 39.5), pg_temp.payload());
  v_job := (v_out->'jobIds'->>0)::uuid;
  perform public.fn_settle_job(v_job, 'failed', null, null, '{}'::jsonb, 'provider refused');
  assert (select status from public.generations
          where id = (v_out->'generationIds'->>0)::uuid) = 'failed';

  begin
    perform public.fn_reserve_generation(
      v_user, gen_random_uuid(), 'hash-7b', pg_temp.items(1, 'video', 100),
      pg_temp.quote(100, 1.0), pg_temp.payload());
  exception when others then v_raised := sqlerrm;
  end;
  assert v_raised = 'daily_cap', format('expected daily_cap, got "%s"', v_raised);
end $$;

-- 8. An owner pays nothing and still gets a job and an expense record: the
--    provider still bills us.
do $$
declare
  v_user uuid := 'cccccccc-0000-4000-8000-000000000008';
begin
  perform pg_temp.seed_user(v_user, 'reserve8@example.com', 0);
  update public.subscriptions set plan = 'owner' where user_id = v_user;
  perform public.fn_reserve_generation(
    v_user, gen_random_uuid(), 'hash-8', pg_temp.items(1, 'image', 0),
    pg_temp.quote(0, 0.012), pg_temp.payload());
  assert (select count(*) from public.jobs where user_id = v_user) = 1;
  assert (select reserved_usd from public.provider_expenses where user_id = v_user) = 0.012;
end $$;

-- 9. An unknown provider is refused outright rather than stored as 'unknown'.
do $$
declare
  v_user uuid := 'cccccccc-0000-4000-8000-000000000009';
  v_raised text := '';
begin
  perform pg_temp.seed_user(v_user, 'reserve9@example.com', 1000);
  begin
    perform public.fn_reserve_generation(
      v_user, gen_random_uuid(), 'hash-9', pg_temp.items(1, 'image', 40),
      pg_temp.quote(40, 0.012, 'mystery'), pg_temp.payload());
  exception when others then v_raised := sqlerrm;
  end;
  assert v_raised = 'unknown_provider', format('expected unknown_provider, got "%s"', v_raised);
  assert (select count(*) from public.generations where user_id = v_user) = 0;
end $$;

-- 10. Persona creation is capped by the plan's slots, under the same lock.
do $$
declare
  v_user uuid := 'cccccccc-0000-4000-8000-000000000010';
  v_raised text := '';
  i int;
begin
  perform pg_temp.seed_user(v_user, 'reserve10@example.com', 10000);
  update public.subscriptions set plan = 'studio' where user_id = v_user;
  for i in 1..2 loop
    perform public.fn_reserve_persona(v_user, gen_random_uuid(), 'hash-p' || i, 'Persona ' || i);
  end loop;
  begin
    perform public.fn_reserve_persona(v_user, gen_random_uuid(), 'hash-p3', 'Persona 3');
  exception when others then v_raised := sqlerrm;
  end;
  assert v_raised = 'slot_limit', format('expected slot_limit, got "%s"', v_raised);
  assert (select count(*) from public.personas where user_id = v_user) = 2;
end $$;

-- 11. Training charges the persona and creates exactly one training job with
--     its own expense row, and settling it refunds once.
do $$
declare
  v_user uuid := 'cccccccc-0000-4000-8000-000000000011';
  v_persona uuid; v_out jsonb; v_job uuid; v_token uuid; v_refunds int;
begin
  perform pg_temp.seed_user(v_user, 'reserve11@example.com', 10000);
  v_persona := (public.fn_reserve_persona(
    v_user, gen_random_uuid(), 'hash-11', 'Trainee')->>'personaId')::uuid;
  update public.personas set photo_paths = '["a","b","c","d","e"]'::jsonb where id = v_persona;

  v_out := public.fn_reserve_training(
    v_user, v_persona, gen_random_uuid(), 'hash-11t',
    jsonb_build_object('provider', 'fal', 'unitCredits', 350, 'unitProviderCostUsd', 2.0));
  v_job := (v_out->>'trainingJobId')::uuid;
  assert (select status from public.personas where id = v_persona) = 'training';
  assert (select count(*) from public.training_jobs where persona_id = v_persona) = 1;
  assert (select reserved_usd from public.training_provider_expenses where job_id = v_job) = 2.0;

  -- Only a live lease may settle. Stand in for the worker's claim (Task 3
  -- adds the RPC that issues these) so the fencing is actually exercised.
  update public.training_jobs
     set lease_token = gen_random_uuid(), lease_until = now() + interval '2 minutes'
   where id = v_job returning lease_token into v_token;
  assert (public.fn_settle_training(v_job, gen_random_uuid(), 'failed', null, 'stale')
          ->>'settled')::boolean = false,
    'a stale token must not settle a training job';
  assert (select status from public.personas where id = v_persona) = 'training';

  perform public.fn_settle_training(v_job, v_token, 'failed', null, 'provider refused');
  assert (select status from public.personas where id = v_persona) = 'failed';
  select coalesce(sum(amount_credits), 0) into v_refunds from public.ledger_entries
    where user_id = v_user and type = 'refund';
  assert v_refunds = 350, format('expected one 350 refund, got %s', v_refunds);
end $$;

-- 12. A replay must still be answered when the account has since run out of
--     money: the work was already paid for and already exists.
do $$
declare
  v_user uuid := 'cccccccc-0000-4000-8000-000000000012';
  v_key uuid := 'dddddddd-0000-4000-8000-000000000012';
  v_first jsonb; v_replay jsonb;
begin
  perform pg_temp.seed_user(v_user, 'reserve12@example.com', 40);
  v_first := public.fn_reserve_generation(
    v_user, v_key, 'hash-12', pg_temp.items(1, 'image', 40), pg_temp.quote(40, 0.012), pg_temp.payload());
  assert (select plan_credits from public.fn_balances(v_user)) = 0, 'the seed must be spent';

  v_replay := public.fn_reserve_generation(
    v_user, v_key, 'hash-12', pg_temp.items(1, 'image', 40), pg_temp.quote(40, 0.012), pg_temp.payload());
  assert v_first = v_replay, 'a broke account must still get its own result back';
end $$;

-- 13. Lease fencing: a claim never changes lifecycle state, only the current
--     lease may release, and an expired lease loses ownership but NOT its
--     state — resetting a `submitting` job to ready would resubmit paid work.
do $$
declare
  v_user uuid := 'cccccccc-0000-4000-8000-000000000013';
  v_out jsonb; v_job uuid; v_first uuid; v_second uuid; v_claims int;
begin
  perform pg_temp.seed_user(v_user, 'lease13@example.com', 10000);
  v_out := public.fn_reserve_generation(
    v_user, gen_random_uuid(), 'hash-13', pg_temp.items(1, 'image', 40),
    pg_temp.quote(40, 0.012), pg_temp.payload());
  v_job := (v_out->'jobIds'->>0)::uuid;

  select count(*) into v_claims from public.fn_claim_jobs(50) where id = v_job;
  assert v_claims = 1, 'the first worker must get the job';
  select lease_token into v_first from public.jobs where id = v_job;
  assert (select state from public.jobs where id = v_job) = 'ready',
    'a claim must not change lifecycle state';

  select count(*) into v_claims from public.fn_claim_jobs(50) where id = v_job;
  assert v_claims = 0, 'a leased job must not be claimed twice';

  assert public.fn_begin_submit(v_job, v_first), 'the lease holder may start submitting';
  assert (select submit_attempts from public.jobs where id = v_job) = 1;
  assert not public.fn_begin_submit(v_job, v_first),
    'a job already submitting must not be submitted again';

  -- The lease expires mid-flight and another worker takes over.
  update public.jobs set lease_until = now() - interval '1 second' where id = v_job;
  perform public.fn_expire_leases();
  assert (select state from public.jobs where id = v_job) = 'submitting',
    'expiry clears the lease, never the state';
  select count(*) into v_claims from public.fn_claim_jobs(50) where id = v_job;
  assert v_claims = 1;
  select lease_token into v_second from public.jobs where id = v_job;

  assert not public.fn_release_job(v_job, v_first, 'ready'),
    'the stale worker must not release the new lease';
  assert not public.fn_record_provider_ref(v_job, v_first, 'req_stale'),
    'the stale worker must not persist a provider ref';
  assert (select provider_ref from public.jobs where id = v_job) is null;

  assert public.fn_release_job(v_job, v_second, 'submitted', 'req_1', 5);
  assert (select provider_ref from public.jobs where id = v_job) = 'req_1';
  assert (select state from public.jobs where id = v_job) = 'submitted';
  assert (select lease_token from public.jobs where id = v_job) is null;
  assert (select next_run_at from public.jobs where id = v_job) > now();

  select count(*) into v_claims from public.fn_claim_jobs(50) where id = v_job;
  assert v_claims = 0, 'a job with a future next_run_at is not runnable yet';
end $$;

-- 14. A settled job is fenced by its lease too: P4 settlement must not accept a
--     worker that has already been replaced.
do $$
declare
  v_user uuid := 'cccccccc-0000-4000-8000-000000000014';
  v_out jsonb; v_job uuid; v_token uuid; v_settled jsonb;
begin
  perform pg_temp.seed_user(v_user, 'lease14@example.com', 10000);
  v_out := public.fn_reserve_generation(
    v_user, gen_random_uuid(), 'hash-14', pg_temp.items(1, 'image', 40),
    pg_temp.quote(40, 0.012), pg_temp.payload());
  v_job := (v_out->'jobIds'->>0)::uuid;
  perform public.fn_claim_jobs(50);
  select lease_token into v_token from public.jobs where id = v_job;

  v_settled := public.fn_settle_job(v_job, 'done', 'u/g.png', 'supabase', '{}'::jsonb,
                                    null, 'pending', null, gen_random_uuid());
  assert not (v_settled->>'settled')::boolean, 'a stale lease must not settle';
  assert (select status from public.generations
          where id = (v_out->'generationIds'->>0)::uuid) = 'pending';

  v_settled := public.fn_settle_job(v_job, 'done', 'u/g.png', 'supabase', '{}'::jsonb,
                                    null, 'pending', null, v_token);
  assert (v_settled->>'settled')::boolean, 'the lease holder settles';
  assert (select state from public.jobs where id = v_job) = 'done',
    'a settled job is finished work, not runnable';
  assert (select lease_token from public.jobs where id = v_job) is null;
end $$;

-- 15. The timeout sweep may not refund work a provider may be running: it asks
--     again instead. Only work that never left the building can be failed.
do $$
declare
  v_user uuid := 'cccccccc-0000-4000-8000-000000000015';
  v_out jsonb; v_job uuid; v_token uuid;
begin
  perform pg_temp.seed_user(v_user, 'sweep15@example.com', 10000);
  v_out := public.fn_reserve_generation(
    v_user, gen_random_uuid(), 'hash-15', pg_temp.items(1, 'image', 40),
    pg_temp.quote(40, 0.012), pg_temp.payload());
  v_job := (v_out->'jobIds'->>0)::uuid;
  perform public.fn_claim_jobs(50);
  select lease_token into v_token from public.jobs where id = v_job;
  perform public.fn_release_job(v_job, v_token, 'submitted', 'req_15', 0);

  perform public.fn_fail_job(v_job, 'timeout');

  assert (select status from public.generations
          where id = (v_out->'generationIds'->>0)::uuid) = 'pending',
    'a submitted job must not be refunded on a timeout';
  assert (select count(*) from public.ledger_entries
          where user_id = v_user and type = 'refund') = 0;
  assert (select state from public.jobs where id = v_job) = 'reconciling',
    'it goes back to the worker to ask the provider';
end $$;

-- 16. Work that never reached a provider IS failed on a timeout, and refunded.
do $$
declare
  v_user uuid := 'cccccccc-0000-4000-8000-000000000016';
  v_out jsonb; v_job uuid;
begin
  perform pg_temp.seed_user(v_user, 'sweep16@example.com', 10000);
  v_out := public.fn_reserve_generation(
    v_user, gen_random_uuid(), 'hash-16', pg_temp.items(1, 'image', 40),
    pg_temp.quote(40, 0.012), pg_temp.payload());
  v_job := (v_out->'jobIds'->>0)::uuid;

  perform public.fn_fail_job(v_job, 'timeout');

  assert (select status from public.generations
          where id = (v_out->'generationIds'->>0)::uuid) = 'failed';
  assert (select coalesce(sum(amount_credits), 0) from public.ledger_entries
          where user_id = v_user and type = 'refund') = 40;
  assert (select state from public.jobs where id = v_job) = 'done';
end $$;

-- 17. The invariant the whole plan rests on: a customer who has been charged
-- always has something queued to do the work. A `pending` generation with no
-- job row is money taken for work nobody will ever run.
do $$
declare
  v_user uuid := 'cccccccc-0000-4000-8000-000000000017';
  v_orphans int;
begin
  perform pg_temp.seed_user(v_user, 'invariant17@example.com', 10000);
  perform public.fn_reserve_generation(
    v_user, gen_random_uuid(), 'hash-17a', pg_temp.items(3, 'image', 40),
    pg_temp.quote(40, 0.012), pg_temp.payload());
  perform public.fn_reserve_generation(
    v_user, gen_random_uuid(), 'hash-17b', pg_temp.items(1, 'video', 100),
    pg_temp.quote(100, 1.2), pg_temp.payload());

  select count(*) into v_orphans
    from public.generations g
    left join public.jobs j on j.generation_id = g.id
   where g.status = 'pending' and j.id is null;
  assert v_orphans = 0, 'a pending generation with no job is paid work nobody will run';
end $$;

rollback;
