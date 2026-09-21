-- Real-database gate for the request snapshot (0023).
--
-- `snapshot_capture_test.ts` proves the gateway BUILDS the right snapshot.
-- This proves the half a fake database cannot: that the snapshot, the charge,
-- the generations, their jobs and the expense are one transaction, that a
-- replay does not write a second snapshot, and that a batch of four shares
-- one immutable record of the single request that produced them.
--
-- How to run:
--
--   supabase start
--   export VANSEN_LOCAL_DB=postgresql://postgres:postgres@127.0.0.1:54322/postgres
--   psql "$VANSEN_LOCAL_DB" -X -v ON_ERROR_STOP=1 -f supabase/tests/request_snapshots.sql
--
-- Every fixture is rolled back: the file runs inside one transaction and ends
-- with `rollback`.

\set ON_ERROR_STOP on
\timing off

begin;

-- ---------------------------------------------------------------- fixtures --
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000f1', 'snap@test.invalid');
insert into public.profiles (id, display_name) values
  ('00000000-0000-0000-0000-0000000000f1', 'snap user')
on conflict (id) do nothing;

-- An owner account: fn_charge_and_generate lets an owner through without a
-- balance, which keeps this file about snapshots rather than about credits.
insert into public.subscriptions (user_id, plan, status, current_period_end)
values ('00000000-0000-0000-0000-0000000000f1', 'owner', 'active', now() + interval '1 year')
on conflict (user_id) do update set plan = 'owner', status = 'active';

-- Budget limits out of the way — this file is not testing the caps.
insert into public.dispatch_limits (key, value) values
  ('daily_global_usd', 1000000), ('daily_provider_usd:fal', 1000000)
on conflict (key) do update set value = excluded.value;

create temporary table t_args (
  items jsonb,
  quote jsonb,
  payload jsonb
) on commit drop;

insert into t_args values (
  jsonb_build_array(jsonb_build_object(
    'kind', 'image', 'familyId', 'flux', 'familyName', 'FLUX', 'op', 'generate',
    'prompt', 'a cat', 'settings', '{"aspectRatio":"1:1"}'::jsonb,
    'priceCredits', 5, 'mediaUrl', '', 'client', 'web')),
  jsonb_build_object(
    'provider', 'fal', 'chargeType', 'generate', 'unitCredits', 5,
    'unitProviderCostUsd', 0.03, 'catalogVersion', 'cat-test', 'quoteVersion', 1),
  jsonb_build_object(
    'familyId', 'flux', 'op', 'generate',
    'snapshot', jsonb_build_object(
      'version', 1, 'op', 'generate', 'familyId', 'flux', 'prompt', 'a cat',
      'settings', '{"aspectRatio":"1:1"}'::jsonb,
      'referenceUploadIds', '[]'::jsonb,
      'referenceSlots', '{"first":null,"last":null,"references":[]}'::jsonb,
      'maskUploadId', null, 'personaId', null, 'styleId', null, 'trendId', null,
      'mode', null, 'parentId', null,
      'catalogVersion', 'cat-test', 'quoteVersion', 1))
);

-- --------------------------------------- a submission records one snapshot --
do $$
declare
  v_args record; v_result jsonb; v_ids uuid[]; v_snap uuid;
begin
  select * into v_args from t_args;
  v_result := public.fn_reserve_generation(
    '00000000-0000-0000-0000-0000000000f1',
    '00000000-0000-0000-0000-0000000000e1',
    'hash-1', v_args.items, v_args.quote, v_args.payload);

  select array_agg(value::uuid) into v_ids
    from jsonb_array_elements_text(v_result->'generationIds');
  if coalesce(array_length(v_ids, 1), 0) <> 1 then
    raise exception 'expected one generation, got %', v_ids;
  end if;

  select snapshot_id into v_snap from public.generations where id = v_ids[1];
  if v_snap is null then
    raise exception 'the generation was created with no snapshot';
  end if;
  if (select count(*) from public.request_snapshots
       where user_id = '00000000-0000-0000-0000-0000000000f1') <> 1 then
    raise exception 'expected exactly one snapshot row';
  end if;
  if (select body->>'catalogVersion' from public.request_snapshots where id = v_snap)
     <> 'cat-test' then
    raise exception 'the snapshot body was not stored verbatim';
  end if;
end $$;

-- ------------------------------------ a replay writes no SECOND snapshot ---
do $$
declare
  v_args record; v_result jsonb;
begin
  select * into v_args from t_args;
  -- Same key, same hash: the replay path returns the first result untouched.
  v_result := public.fn_reserve_generation(
    '00000000-0000-0000-0000-0000000000f1',
    '00000000-0000-0000-0000-0000000000e1',
    'hash-1', v_args.items, v_args.quote, v_args.payload);

  if (select count(*) from public.request_snapshots
       where user_id = '00000000-0000-0000-0000-0000000000f1') <> 1 then
    raise exception 'a replay wrote a duplicate snapshot';
  end if;
  if (select count(*) from public.generations
       where user_id = '00000000-0000-0000-0000-0000000000f1') <> 1 then
    raise exception 'a replay created a second generation';
  end if;
end $$;

-- ------------------------- a batch of four SHARES one immutable snapshot ---
do $$
declare
  v_args record; v_items jsonb; v_result jsonb; v_ids uuid[]; v_distinct int;
begin
  select * into v_args from t_args;
  v_items := v_args.items || v_args.items || v_args.items || v_args.items;
  v_items := jsonb_path_query_array(v_items, '$[*]');

  v_result := public.fn_reserve_generation(
    '00000000-0000-0000-0000-0000000000f1',
    '00000000-0000-0000-0000-0000000000e2',
    'hash-2', v_items, v_args.quote, v_args.payload);

  select array_agg(value::uuid) into v_ids
    from jsonb_array_elements_text(v_result->'generationIds');
  if array_length(v_ids, 1) <> 4 then
    raise exception 'expected four generations, got %', array_length(v_ids, 1);
  end if;

  select count(distinct snapshot_id) into v_distinct
    from public.generations where id = any(v_ids);
  if v_distinct <> 1 then
    raise exception 'four outputs of one request must share one snapshot, got %', v_distinct;
  end if;
  if (select count(*) from public.generations where id = any(v_ids) and snapshot_id is null) > 0 then
    raise exception 'some generations in the batch got no snapshot';
  end if;
end $$;

-- ---------------------------- a missing snapshot charges and creates nothing --
do $$
declare
  v_args record; v_before int; v_gens int; v_snaps int;
begin
  select * into v_args from t_args;
  select count(*) into v_before from public.ledger_entries
   where user_id = '00000000-0000-0000-0000-0000000000f1';
  select count(*) into v_gens from public.generations
   where user_id = '00000000-0000-0000-0000-0000000000f1';
  select count(*) into v_snaps from public.request_snapshots
   where user_id = '00000000-0000-0000-0000-0000000000f1';

  begin
    perform public.fn_reserve_generation(
      '00000000-0000-0000-0000-0000000000f1',
      '00000000-0000-0000-0000-0000000000e3',
      'hash-3', v_args.items, v_args.quote,
      v_args.payload - 'snapshot');
    raise exception 'a submission with no snapshot was accepted';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'snapshot_required' then
      raise exception 'expected snapshot_required, got %', sqlerrm;
    end if;
  end;

  if (select count(*) from public.ledger_entries
       where user_id = '00000000-0000-0000-0000-0000000000f1') <> v_before then
    raise exception 'a rejected submission still charged the customer';
  end if;
  if (select count(*) from public.generations
       where user_id = '00000000-0000-0000-0000-0000000000f1') <> v_gens then
    raise exception 'a rejected submission still created a generation';
  end if;
  if (select count(*) from public.request_snapshots
       where user_id = '00000000-0000-0000-0000-0000000000f1') <> v_snaps then
    raise exception 'a rejected submission left an orphan snapshot';
  end if;
end $$;

-- -------------------------------- the client may not name its own snapshot --
do $$
declare
  v_args record;
begin
  select * into v_args from t_args;
  begin
    perform public.fn_reserve_generation(
      '00000000-0000-0000-0000-0000000000f1',
      '00000000-0000-0000-0000-0000000000e4',
      'hash-4', v_args.items, v_args.quote,
      jsonb_set(v_args.payload, '{snapshot,snapshotId}', '"forged"'::jsonb));
    raise exception 'a client-supplied snapshot id was accepted';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'bad_snapshot' then
      raise exception 'expected bad_snapshot, got %', sqlerrm;
    end if;
  end;
end $$;

-- ------------------------------ a charge failure leaves no snapshot behind --
--
-- The previous account is an owner, which never runs out. This one is not: the
-- charge raises insufficient_balance AFTER the snapshot insert, which is the
-- ordering that would leak a row if the two were not one transaction.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000f2', 'broke@test.invalid');
insert into public.profiles (id, display_name) values
  ('00000000-0000-0000-0000-0000000000f2', 'broke user')
on conflict (id) do nothing;

do $$
declare
  v_args record;
begin
  select * into v_args from t_args;
  begin
    perform public.fn_reserve_generation(
      '00000000-0000-0000-0000-0000000000f2',
      '00000000-0000-0000-0000-0000000000e5',
      'hash-5', v_args.items, v_args.quote, v_args.payload);
    raise exception 'a submission with no credits was accepted';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'insufficient_balance' then
      raise exception 'expected insufficient_balance, got %', sqlerrm;
    end if;
  end;
end $$;

-- The subtransaction above rolled back; nothing of it may survive.
do $$
begin
  if (select count(*) from public.request_snapshots
       where user_id = '00000000-0000-0000-0000-0000000000f2') <> 0 then
    raise exception 'a failed charge left an orphan snapshot';
  end if;
  if (select count(*) from public.generations
       where user_id = '00000000-0000-0000-0000-0000000000f2') <> 0 then
    raise exception 'a failed charge left a generation';
  end if;
end $$;

-- ------------------------------- a mask is a first-class upload purpose ----
do $$
begin
  insert into public.uploads (user_id, path, purpose, mime, bytes, width, height, moderation)
  values ('00000000-0000-0000-0000-0000000000f1',
          '00000000-0000-0000-0000-0000000000f1/mask-1.png',
          'mask', 'image/png', 1024, 512, 512, 'allowed');
exception when check_violation then
  raise exception 'the mask purpose was not added to the uploads registry';
end $$;

-- ----------------------------- deleting a snapshot never deletes its work --
do $$
declare v_gen uuid; v_snap uuid;
begin
  select id, snapshot_id into v_gen, v_snap from public.generations
   where user_id = '00000000-0000-0000-0000-0000000000f1' limit 1;
  delete from public.request_snapshots where id = v_snap;
  if not exists (select 1 from public.generations where id = v_gen) then
    raise exception 'deleting a snapshot cascaded into the generation';
  end if;
  if (select snapshot_id from public.generations where id = v_gen) is not null then
    raise exception 'the dangling snapshot reference was not nulled';
  end if;
end $$;

select 'request_snapshots.sql: all assertions passed' as result;

rollback;
