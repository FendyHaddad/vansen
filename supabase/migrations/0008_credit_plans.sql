-- 0008: credit-denominated two-bucket ledger, subscription plans as sole access,
-- Pro-only video, cycle resets, pack roll-over. Dev data wiped (Stripe TEST mode).

-- 0. Wipe dev money/library data --------------------------------------------
truncate public.generations cascade;      -- cascades to jobs
delete from public.ledger_entries;
delete from public.webhook_events;

-- 1. Ledger: integer credits + bucket ----------------------------------------
alter table public.ledger_entries
  drop column amount_usd,
  add column amount_credits integer not null default 0,
  add column bucket text not null default 'plan' check (bucket in ('plan','pack'));
alter table public.ledger_entries alter column amount_credits drop default;
alter table public.ledger_entries drop constraint ledger_entries_type_check;
alter table public.ledger_entries add constraint ledger_entries_type_check
  check (type in ('generate','edit','upscale','refund','pack_purchase','cycle_reset','pack_expiry','promo'));

-- 2. Generations: credit price + per-bucket charge attribution ----------------
alter table public.generations
  drop column price_usd,
  add column price_credits integer not null default 0,
  add column charged_plan integer not null default 0,
  add column charged_pack integer not null default 0;
alter table public.generations alter column price_credits drop default;

-- 3. Video (and any future premium family) is Pro-only ------------------------
alter table public.models
  add column min_plan text not null default 'studio' check (min_plan in ('studio','pro'));
update public.models set min_plan = 'pro'
  where id in ('veo','sora','kling','runway','seedance');

-- 4. Balances ------------------------------------------------------------------
drop function if exists public.fn_balance(uuid);
create or replace function public.fn_balances(p_user uuid)
returns table(plan_credits int, pack_credits int)
language sql security definer set search_path = public as $$
  select
    coalesce(sum(amount_credits) filter (where bucket = 'plan'), 0)::int,
    coalesce(sum(amount_credits) filter (where bucket = 'pack'), 0)::int
  from public.ledger_entries where user_id = p_user;
$$;

-- 5. Charge: plan bucket first, then pack; per-item attribution for refunds ----
drop function if exists public.fn_charge_and_generate(uuid, numeric, text, text, text, jsonb);
create or replace function public.fn_charge_and_generate(
  p_user uuid, p_amount int, p_type text, p_family_id text, p_note text, p_items jsonb
) returns setof public.generations
language plpgsql security definer set search_path = public as $$
declare
  v_plan int; v_pack int; v_owner boolean;
  v_from_plan int; v_from_pack int; v_rem_plan int;
  v_item jsonb; v_price int; v_cp int;
begin
  perform pg_advisory_xact_lock(hashtext(p_user::text));
  select exists (
    select 1 from public.subscriptions
    where user_id = p_user and plan = 'owner' and status = 'active'
  ) into v_owner;
  select bal.plan_credits, bal.pack_credits into v_plan, v_pack
    from public.fn_balances(p_user) bal;
  if not v_owner and v_plan + v_pack < p_amount then
    raise exception 'insufficient_balance' using errcode = 'P0001';
  end if;
  -- Owner usage is tracked as plan spend; balance may go negative by design.
  v_from_plan := case when v_owner then p_amount else least(greatest(v_plan, 0), p_amount) end;
  v_from_pack := p_amount - v_from_plan;
  if v_from_plan > 0 then
    insert into public.ledger_entries (user_id, type, bucket, amount_credits, family_id, note)
    values (p_user, p_type, 'plan', -v_from_plan, p_family_id, p_note);
  end if;
  if v_from_pack > 0 then
    insert into public.ledger_entries (user_id, type, bucket, amount_credits, family_id, note)
    values (p_user, p_type, 'pack', -v_from_pack, p_family_id, p_note);
  end if;
  v_rem_plan := v_from_plan;
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_price := (v_item->>'priceCredits')::int;
    v_cp := least(v_rem_plan, v_price);
    v_rem_plan := v_rem_plan - v_cp;
    return query
      insert into public.generations
        (user_id, kind, family_id, family_name, op, prompt, settings,
         price_credits, charged_plan, charged_pack, status, media_url, parent_id)
      values (
        p_user,
        v_item->>'kind', v_item->>'familyId', v_item->>'familyName', v_item->>'op',
        v_item->>'prompt', coalesce(v_item->'settings', '{}'::jsonb),
        v_price, v_cp, v_price - v_cp, 'pending', coalesce(v_item->>'mediaUrl', ''),
        nullif(v_item->>'parentId','')::uuid
      ) returning *;
  end loop;
end $$;

-- 6. Refund goes back to the buckets that paid (once per generation per bucket) --
create or replace function public.fn_fail_job(p_job uuid, p_error text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_gen uuid; v_user uuid; v_status text; v_cp int; v_cpack int;
begin
  select j.generation_id, j.user_id into v_gen, v_user from public.jobs j where j.id = p_job;
  if v_gen is null then return; end if;
  update public.jobs set error = p_error, updated_at = now() where id = p_job;
  select status, charged_plan, charged_pack into v_status, v_cp, v_cpack
    from public.generations where id = v_gen;
  if v_status is distinct from 'pending' then return; end if;
  update public.generations set status = 'failed' where id = v_gen;
  if v_cp > 0 then
    insert into public.ledger_entries (user_id, type, bucket, amount_credits, note)
    values (v_user, 'refund', 'plan', v_cp, 'refund:' || v_gen::text || ':plan')
    on conflict do nothing;
  end if;
  if v_cpack > 0 then
    insert into public.ledger_entries (user_id, type, bucket, amount_credits, note)
    values (v_user, 'refund', 'pack', v_cpack, 'refund:' || v_gen::text || ':pack')
    on conflict do nothing;
  end if;
end $$;

-- 7. Cycle reset: plan bucket snaps to the grant; packs untouched ---------------
create or replace function public.fn_cycle_reset(p_user uuid, p_grant int)
returns void language plpgsql security definer set search_path = public as $$
declare v_plan int;
begin
  perform pg_advisory_xact_lock(hashtext(p_user::text));
  select bal.plan_credits into v_plan from public.fn_balances(p_user) bal;
  insert into public.ledger_entries (user_id, type, bucket, amount_credits, note)
  values (p_user, 'cycle_reset', 'plan', p_grant - v_plan, 'Cycle renewal grant');
end $$;

-- 8. Pack grant (webhook only; stripe_ref UNIQUE = one session, one grant) ------
create or replace function public.fn_grant_pack(p_user uuid, p_credits int, p_stripe_ref text)
returns void language sql security definer set search_path = public as $$
  insert into public.ledger_entries (user_id, type, bucket, amount_credits, note, stripe_ref)
  values (p_user, 'pack_purchase', 'pack', p_credits, 'Credit pack', p_stripe_ref)
  on conflict (stripe_ref) do nothing;
$$;

-- 9. Pack credits die 30 days after the subscription lapses --------------------
select cron.schedule('expire_lapsed_packs', '30 3 * * *', $$
  insert into public.ledger_entries (user_id, type, bucket, amount_credits, note)
  select s.user_id, 'pack_expiry', 'pack', -bal.pack, 'Pack expiry (subscription lapsed)'
  from public.subscriptions s
  join lateral (
    select coalesce(sum(amount_credits), 0)::int as pack
    from public.ledger_entries l where l.user_id = s.user_id and l.bucket = 'pack'
  ) bal on true
  where s.status = 'expired'
    and s.current_period_end < now() - interval '30 days'
    and bal.pack > 0
$$);

-- 10. Backoffice readers still reference dropped columns — repoint to credits ----
create or replace function public.backoffice_owner_usage()
returns jsonb language sql security definer set search_path = public as $$
select coalesce(jsonb_agg(jsonb_build_object(
  'userId', s.user_id,
  'email', (select email from auth.users where id = s.user_id),
  'displayName', p.display_name,
  'generations', (select count(*) from generations g where g.user_id = s.user_id),
  'spendCredits', coalesce((select sum(price_credits) from generations g where g.user_id = s.user_id), 0),
  'planCredits', coalesce((select sum(amount_credits) from ledger_entries l where l.user_id = s.user_id and l.bucket = 'plan'), 0),
  'packCredits', coalesce((select sum(amount_credits) from ledger_entries l where l.user_id = s.user_id and l.bucket = 'pack'), 0),
  'daily', (select coalesce(jsonb_agg(jsonb_build_object('day', d.day, 'value', coalesce(g.c, 0)) order by d.day), '[]'::jsonb)
            from (select generate_series(current_date - 29, current_date, interval '1 day')::date as day) d
            left join (select created_at::date as day, count(*) c from generations
                       where user_id = s.user_id and created_at > current_date - 29 group by 1) g using (day))
)), '[]'::jsonb)
from subscriptions s
join profiles p on p.id = s.user_id
where s.plan = 'owner';
$$;

-- backoffice_summary: gen_cost_usd_30d → gen_credits_30d, body otherwise as 0007 §7.
create or replace function public.backoffice_summary()
returns jsonb language sql security definer set search_path = public as $$
select jsonb_build_object(
  'users', (select count(*) from profiles),
  'users_7d', (select count(*) from profiles where created_at > now() - interval '7 days'),
  'active_subscriptions', (select count(*) from subscriptions where status = 'active'),
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

-- 11. Lockdown -------------------------------------------------------------------
revoke execute on function public.fn_balances(uuid) from public, anon, authenticated;
revoke execute on function public.fn_charge_and_generate(uuid, int, text, text, text, jsonb) from public, anon, authenticated;
revoke execute on function public.fn_cycle_reset(uuid, int) from public, anon, authenticated;
revoke execute on function public.fn_grant_pack(uuid, int, text) from public, anon, authenticated;
grant execute on function public.fn_balances(uuid) to service_role;
grant execute on function public.fn_charge_and_generate(uuid, int, text, text, text, jsonb) to service_role;
grant execute on function public.fn_cycle_reset(uuid, int) to service_role;
grant execute on function public.fn_grant_pack(uuid, int, text) to service_role;
