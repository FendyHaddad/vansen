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

  -- Exactly one check on generations.client: if 0014's constraint had a
  -- non-default name, `drop constraint if exists` would miss it and the old
  -- check would refuse every MCP generation.
  assert (select count(*) from pg_constraint
           where conrelid = 'public.generations'::regclass and contype = 'c'
             and pg_get_constraintdef(oid) like '%client%') = 1,
    'generations must carry a single client check';

  insert into auth.users (id, email)
  values ('aaaa0000-0000-4000-8000-00000000035a', 'mcp-client@example.com');
  insert into public.profiles (id, birth_date)
  values ('aaaa0000-0000-4000-8000-00000000035a', '1990-01-01') on conflict (id) do nothing;
  insert into public.generations
    (user_id, kind, status, family_id, family_name, op, prompt, media_url, price_credits, client)
  values ('aaaa0000-0000-4000-8000-00000000035a', 'image', 'pending', 'flux', 'FLUX', 'generate',
          'a fox', '', 5, 'mcp');
  begin
    insert into public.generations
      (user_id, kind, status, family_id, family_name, op, prompt, media_url, price_credits, client)
    values ('aaaa0000-0000-4000-8000-00000000035a', 'image', 'pending', 'flux', 'FLUX', 'generate',
            'a fox', '', 5, 'desktop');
    raise exception 'an unknown generations client tag was accepted';
  exception when check_violation then null;
  end;

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
