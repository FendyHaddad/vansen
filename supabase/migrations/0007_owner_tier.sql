-- 0007: plans studio|pro|owner; owner = hidden internal tier, unlimited credits,
-- usage still ledger-tracked. plan_grants pre-provisions plans by email.

-- 1. Plan rename + owner ------------------------------------------------------
update public.subscriptions set plan = 'pro' where plan = 'studio_pro';
alter table public.subscriptions drop constraint subscriptions_plan_check;
alter table public.subscriptions
  add constraint subscriptions_plan_check check (plan in ('studio','pro','owner'));

-- 2. plan_grants: email → plan, applied at signup or immediately by backoffice
create table public.plan_grants (
  email      text primary key,
  plan       text not null check (plan in ('studio','pro','owner')),
  granted_by text not null,
  created_at timestamptz not null default now()
);
alter table public.plan_grants enable row level security; -- deny-all: no policies

-- 3. Signup trigger applies any waiting grant (best-effort: never block signup)
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_plan text;
begin
  insert into public.profiles (id) values (new.id);
  begin
    select plan into v_plan from public.plan_grants where email = lower(new.email);
    if v_plan is not null then
      insert into public.subscriptions (user_id, plan, status, current_period_end)
      values (new.id, v_plan, 'active', null)
      on conflict (user_id) do update
        set plan = excluded.plan, status = 'active',
            current_period_end = null, updated_at = now();
    end if;
  exception when others then
    null; -- a broken grant must never block signup
  end;
  return new;
end $$;

-- 4. Owner bypass: skip the balance gate, keep the charge row (usage tracking)
create or replace function public.fn_charge_and_generate(
  p_user uuid, p_amount numeric, p_type text, p_family_id text, p_note text, p_items jsonb
) returns setof public.generations
language plpgsql security definer set search_path = public as $$
declare
  v_balance numeric;
  v_owner boolean;
  v_item jsonb;
begin
  perform pg_advisory_xact_lock(hashtext(p_user::text));
  select exists (
    select 1 from public.subscriptions
    where user_id = p_user and plan = 'owner' and status = 'active'
  ) into v_owner;
  if not v_owner then
    select coalesce(sum(amount_usd), 0) into v_balance
      from public.ledger_entries where user_id = p_user;
    if v_balance < p_amount then
      raise exception 'insufficient_balance' using errcode = 'P0001';
    end if;
  end if;
  insert into public.ledger_entries (user_id, type, amount_usd, family_id, note)
  values (p_user, p_type, -p_amount, p_family_id, p_note);
  for v_item in select * from jsonb_array_elements(p_items) loop
    return query
      insert into public.generations
        (user_id, kind, family_id, family_name, op, prompt, settings, price_usd, status, media_url, parent_id)
      values (
        p_user,
        v_item->>'kind', v_item->>'familyId', v_item->>'familyName', v_item->>'op',
        v_item->>'prompt', coalesce(v_item->'settings', '{}'::jsonb),
        (v_item->>'priceUsd')::numeric, 'pending', coalesce(v_item->>'mediaUrl', ''),
        nullif(v_item->>'parentId','')::uuid
      ) returning *;
  end loop;
end $$;

-- 5. Backoffice: set/revoke a plan by email --------------------------------
create or replace function public.backoffice_set_plan(p_email text, p_plan text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_email text := lower(trim(p_email));
  v_user uuid;
  v_stripe text;
begin
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    return jsonb_build_object('ok', false, 'error', 'invalid_email');
  end if;
  if p_plan is not null and p_plan not in ('studio','pro','owner') then
    return jsonb_build_object('ok', false, 'error', 'invalid_plan');
  end if;

  select id into v_user from auth.users where lower(email) = v_email;

  if p_plan is null then
    delete from public.plan_grants where email = v_email;
    if v_user is not null then
      delete from public.subscriptions
        where user_id = v_user and stripe_subscription_id is null;
    end if;
    return jsonb_build_object('ok', true, 'applied', v_user is not null);
  end if;

  if v_user is not null then
    select stripe_subscription_id into v_stripe
      from public.subscriptions where user_id = v_user;
    if v_stripe is not null then
      return jsonb_build_object('ok', false, 'error', 'stripe_subscription_exists');
    end if;
    insert into public.subscriptions (user_id, plan, status, current_period_end)
    values (v_user, p_plan, 'active', null)
    on conflict (user_id) do update
      set plan = excluded.plan, status = 'active',
          current_period_end = null, updated_at = now();
  end if;

  insert into public.plan_grants (email, plan, granted_by)
  values (v_email, p_plan, 'backoffice')
  on conflict (email) do update set plan = excluded.plan, granted_by = 'backoffice';

  return jsonb_build_object('ok', true, 'applied', v_user is not null);
end $$;

-- 6. Backoffice: per-owner usage ---------------------------------------------
create or replace function public.backoffice_owner_usage()
returns jsonb language sql security definer set search_path = public as $$
select coalesce(jsonb_agg(jsonb_build_object(
  'userId', s.user_id,
  'email', (select email from auth.users where id = s.user_id),
  'displayName', p.display_name,
  'generations', (select count(*) from generations g where g.user_id = s.user_id),
  'spendUsd', coalesce((select sum(price_usd) from generations g where g.user_id = s.user_id), 0),
  'balanceUsd', coalesce((select sum(amount_usd) from ledger_entries l where l.user_id = s.user_id), 0),
  'daily', (select coalesce(jsonb_agg(jsonb_build_object('day', d.day, 'value', coalesce(g.c, 0)) order by d.day), '[]'::jsonb)
            from (select generate_series(current_date - 29, current_date, interval '1 day')::date as day) d
            left join (select created_at::date as day, count(*) c from generations
                       where user_id = s.user_id and created_at > current_date - 29 group by 1) g using (day))
)), '[]'::jsonb)
from subscriptions s
join profiles p on p.id = s.user_id
where s.plan = 'owner';
$$;

-- 7. backoffice_summary: recent gains app_errors -------------------------------
create or replace function public.backoffice_summary()
returns jsonb language sql security definer set search_path = public as $$
select jsonb_build_object(
  'users', (select count(*) from profiles),
  'users_7d', (select count(*) from profiles where created_at > now() - interval '7 days'),
  'active_subscriptions', (select count(*) from subscriptions where status = 'active'),
  'generations_total', (select count(*) from generations),
  'generations_7d', (select count(*) from generations where created_at > now() - interval '7 days'),
  'failed_jobs_7d', (select count(*) from jobs where error is not null and updated_at > now() - interval '7 days'),
  'gen_cost_usd_30d', coalesce((select sum(price_usd) from generations where created_at > now() - interval '30 days'), 0),
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

-- 8. Lockdown + seed ------------------------------------------------------------
revoke execute on function public.backoffice_set_plan(text, text) from public, anon, authenticated;
revoke execute on function public.backoffice_owner_usage() from public, anon, authenticated;
grant execute on function public.backoffice_set_plan(text, text) to service_role;
grant execute on function public.backoffice_owner_usage() to service_role;

insert into public.plan_grants (email, plan, granted_by)
values ('fendyhaddad@google.com', 'owner', 'seed')
on conflict (email) do update set plan = 'owner';
