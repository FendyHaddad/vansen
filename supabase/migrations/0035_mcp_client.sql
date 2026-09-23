-- 0035: assistants connected over MCP (Claude, ChatGPT, ...) are a client.
-- The gateway's /mcp handler stamps client = 'mcp' server-side (never from a
-- header), and draws on its own request bucket `mcp` (10 generate-type calls
-- per user per minute), so an assistant loop and the user's own app cannot
-- starve each other. Spec: docs/superpowers/specs/2026-09-23-mcp-connection-design.md §5.

alter table public.generations drop constraint if exists generations_client_check;
alter table public.generations
  add constraint generations_client_check check (client in ('web', 'ios', 'android', 'mcp'));

alter table public.app_errors drop constraint if exists app_errors_client_check;
alter table public.app_errors
  add constraint app_errors_client_check check (client in ('web', 'ios', 'android', 'mcp'));

alter table public.request_rate_limits drop constraint if exists request_rate_limits_bucket_check;
alter table public.request_rate_limits
  add constraint request_rate_limits_bucket_check check (bucket in ('generation', 'upload', 'mcp'));

-- Same body as 0028 plus the `mcp` budget.
create or replace function public.fn_take_request_slot(p_user uuid,p_bucket text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_limit int; v_started timestamptz; v_attempts int; v_now timestamptz := clock_timestamp();
begin
  v_limit := case p_bucket when 'generation' then 20 when 'upload' then 30 when 'mcp' then 10 else null end;
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
