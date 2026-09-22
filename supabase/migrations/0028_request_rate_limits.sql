-- Small per-account request budgets, before expensive uploads and moderation.
-- Spend/concurrency caps still enforce separate provider-cost constraints.
create table public.request_rate_limits (
  user_id uuid not null references auth.users(id) on delete cascade,
  bucket text not null check(bucket in ('generation','upload')),
  window_started_at timestamptz not null,
  attempts int not null,
  primary key(user_id,bucket)
);
alter table public.request_rate_limits enable row level security;

create or replace function public.fn_take_request_slot(p_user uuid,p_bucket text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_limit int; v_started timestamptz; v_attempts int; v_now timestamptz := clock_timestamp();
begin
  v_limit := case p_bucket when 'generation' then 20 when 'upload' then 30 else null end;
  if v_limit is null then raise exception 'unknown_request_bucket'; end if;
  insert into public.request_rate_limits(user_id,bucket,window_started_at,attempts)
  values(p_user,p_bucket,v_now,1)
  on conflict(user_id,bucket) do update set
    attempts=case when request_rate_limits.window_started_at <= v_now-interval '1 minute'
      then 1 else least(request_rate_limits.attempts+1,v_limit+1) end,
    window_started_at=case when request_rate_limits.window_started_at <= v_now-interval '1 minute'
      then v_now else request_rate_limits.window_started_at end
  returning window_started_at,attempts into v_started,v_attempts;
  return jsonb_build_object('allowed',v_attempts<=v_limit,'retryAfterSeconds',
    case when v_attempts<=v_limit then 0 else greatest(1,ceil(extract(epoch from v_started+interval '1 minute'-v_now))::int) end);
end $$;
revoke all on function public.fn_take_request_slot(uuid,text) from public,anon,authenticated;
grant execute on function public.fn_take_request_slot(uuid,text) to service_role;
