-- 0007: backoffice admin allowlist + codify backoffice_summary() (already live
-- in prod, created 2026-07-12 for the Vankode backoffice dashboard).
-- admins: membership = may call /api/admin/* (read-only in backoffice Phase C).
-- RLS deny-all: only the service_role edge function reads it.
create table public.admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.admins enable row level security; -- deny-all: no policies

insert into public.admins (user_id)
select id from auth.users where email = 'fendyhaddad@vankode.com';

CREATE OR REPLACE FUNCTION public.backoffice_summary()
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  'recent', (select coalesce(jsonb_agg(jsonb_build_object('type', t, 'title', title, 'at', at) order by at desc), '[]'::jsonb)
             from (
               (select 'signup' as t, coalesce(display_name, 'New user') as title, created_at as at
                  from profiles order by created_at desc limit 5)
               union all
               (select 'generation', coalesce(family_name, kind) || ' · ' || coalesce(op, 'create'), created_at
                  from generations order by created_at desc limit 5)
               union all
               (select 'subscription', plan || ' — ' || status, coalesce(updated_at, created_at)
                  from subscriptions order by coalesce(updated_at, created_at) desc limit 5)
             ) ev)
);
$function$;

revoke all on function public.backoffice_summary() from public, anon, authenticated;
grant execute on function public.backoffice_summary() to service_role;
