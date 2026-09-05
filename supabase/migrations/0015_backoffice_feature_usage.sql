-- 0015: feature-usage aggregation for the vankode-backoffice.
-- service_role-only, all aggregation in SQL (no row-cap like client-side aggregation).
-- (applied 2026-07-24 via MCP apply_migration)

create or replace function public.backoffice_feature_usage(p_days int)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_since timestamptz;
  v_out jsonb;
begin
  if p_days < 1 or p_days > 365 then
    raise exception 'days must be 1-365' using errcode = 'P0001';
  end if;
  v_since := now() - make_interval(days => p_days);

  select jsonb_build_object(
    'days', p_days,
    'totalGenerations', (select count(*) from generations where created_at >= v_since),
    'personas',
      (select jsonb_build_object(
         'total', count(*),
         'ready', count(*) filter (where status = 'ready'),
         'training', count(*) filter (where status = 'training'),
         'failed', count(*) filter (where status = 'failed'),
         'usersWithPersona', count(distinct user_id),
         'trainingsInWindow', count(*) filter (where training_started_at >= v_since)
       ) from personas)
      || jsonb_build_object(
         'refundedInWindow',
           (select count(distinct split_part(note, ':', 3)) from ledger_entries
             where note like 'refund:persona:%' and created_at >= v_since),
         'trainingCreditsInWindow',
           (select coalesce(-sum(amount_credits), 0) from ledger_entries
             where type = 'persona_training' and created_at >= v_since))
      || (select jsonb_build_object(
         'genCount', count(*),
         'genUsers', count(distinct user_id),
         'genCredits', coalesce(sum(price_credits) filter (where status <> 'failed'), 0)
       ) from generations
         where created_at >= v_since and settings->>'persona' is not null),
    'styles',
      (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'uses', uses, 'users', users)
                                 order by uses desc), '[]'::jsonb)
         from (select settings->>'style' as id, count(*) as uses, count(distinct user_id) as users
                 from generations
                where created_at >= v_since and settings->>'style' is not null
                group by 1) s),
    'trends',
      (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'uses', uses, 'users', users)
                                 order by uses desc), '[]'::jsonb)
         from (select settings->>'trend' as id, count(*) as uses, count(distinct user_id) as users
                 from generations
                where created_at >= v_since and settings->>'trend' is not null
                group by 1) t),
    'platforms',
      (select coalesce(jsonb_agg(jsonb_build_object('client', client, 'count', n)
                                 order by n desc), '[]'::jsonb)
         from (select client, count(*) as n from generations
                where created_at >= v_since group by client) p),
    'personaDaily',
      (select coalesce(jsonb_agg(jsonb_build_object('d', d, 'count', n) order by d), '[]'::jsonb)
         from (select to_char(date_trunc('day', created_at), 'YYYY-MM-DD') as d, count(*) as n
                 from generations
                where created_at >= v_since and settings->>'persona' is not null
                group by 1) pd)
  ) into v_out;
  return v_out;
end $$;

revoke execute on function public.backoffice_feature_usage(int) from public, anon, authenticated;
grant execute on function public.backoffice_feature_usage(int) to service_role;
