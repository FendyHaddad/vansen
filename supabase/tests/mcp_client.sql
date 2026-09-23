-- 0035: generations and app_errors accept the server-set client tag 'mcp'
-- (an assistant connected over MCP), and still refuse anything unknown.
begin;
do $$
declare def text;
begin
  select pg_get_constraintdef(oid) into def from pg_constraint
   where conrelid = 'public.generations'::regclass and conname = 'generations_client_check';
  assert def like '%mcp%', 'generations.client must accept mcp';
  assert def like '%web%' and def like '%ios%' and def like '%android%', 'existing clients must stay valid';
  select pg_get_constraintdef(oid) into def from pg_constraint
   where conrelid = 'public.app_errors'::regclass and conname = 'app_errors_client_check';
  assert def like '%mcp%', 'app_errors.client must accept mcp';

  insert into public.app_errors(source, route, method, code, message, client)
  values ('api', '/api/mcp', 'POST', 'mcp_test', 'x', 'mcp');
  begin
    insert into public.app_errors(source, route, method, code, message, client)
    values ('api', '/api/mcp', 'POST', 'mcp_test', 'x', 'desktop');
    raise exception 'an unknown client tag was accepted';
  exception when check_violation then null;
  end;
end $$;
rollback;
