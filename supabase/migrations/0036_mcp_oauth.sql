-- 0036: Vansen's own OAuth 2.1 authorization server for assistants (MCP). The
-- gateway issues opaque tokens only /mcp accepts, so GoTrue never sees one (C1).
-- Only SHA-256 hashes of tokens and codes are stored; every state transition is
-- one security definer RPC, so each step is atomic.
-- Spec: §R of docs/superpowers/specs/2026-09-23-mcp-connection-design.md.

-- ------------------------------------------------------------------ tables

create table public.oauth_clients (
  id text primary key check (id ~ '^vsn_client_[A-Za-z0-9_-]{20,64}$'),
  client_name text not null check (char_length(client_name) between 1 and 100),
  redirect_uris text[] not null check (cardinality(redirect_uris) between 1 and 5),
  -- SHA-256 of the registering IP (see clientIp() in oauth/register.ts), for
  -- the 20-per-hour registration limit. Never the address itself.
  registered_ip_hash text not null,
  created_at timestamptz not null default now()
);
create index oauth_clients_ip_recent on public.oauth_clients (registered_ip_hash, created_at);
-- The global registration cap and the purge of clients that never connected.
create index oauth_clients_created on public.oauth_clients (created_at);

-- Pending authorizations, between GET /oauth/authorize and the consent page.
create table public.oauth_requests (
  id uuid primary key default gen_random_uuid(),
  client_id text not null references public.oauth_clients on delete cascade,
  redirect_uri text not null,
  state text check (state is null or char_length(state) <= 1024),
  code_challenge text not null check (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  scope text not null default 'vansen',
  resource text check (resource is null or char_length(resource) <= 2048),
  expires_at timestamptz not null default now() + interval '10 minutes',
  created_at timestamptz not null default now()
);

-- One active grant per user and client. A revoked grant stays revoked: a new
-- approval makes a new row, so nothing tied to the old one can come back.
-- References profiles (which cascades from auth.users), so fn_delete_account's
-- profile delete ends every grant and token at once.
create table public.oauth_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles on delete cascade,
  client_id text not null references public.oauth_clients on delete cascade,
  -- Every redirect URI the user approved on the consent screen for this grant.
  -- Consent auto-approves only a request whose redirect_uri is already here, so
  -- approving one registered host never approves another silently.
  approved_redirect_uris text[] not null default '{}',
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create unique index oauth_grants_one_active
  on public.oauth_grants (user_id, client_id) where revoked_at is null;

create table public.oauth_codes (
  code_hash text primary key check (code_hash ~ '^[0-9a-f]{64}$'),
  grant_id uuid not null references public.oauth_grants on delete cascade,
  request_id uuid not null,
  redirect_uri text not null,
  code_challenge text not null,
  resource text,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index oauth_codes_grant on public.oauth_codes (grant_id);

create table public.oauth_tokens (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  grant_id uuid not null references public.oauth_grants on delete cascade,
  kind text not null check (kind in ('access', 'refresh')),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  -- Set when a refresh token is rotated. Presenting it again is reuse.
  replaced_by text,
  created_at timestamptz not null default now()
);
create index oauth_tokens_grant on public.oauth_tokens (grant_id);

alter table public.oauth_clients enable row level security;
alter table public.oauth_requests enable row level security;
alter table public.oauth_grants enable row level security;
alter table public.oauth_codes enable row level security;
alter table public.oauth_tokens enable row level security;
-- Deny-all by RLS already; token hashes get no table privilege either.
revoke all on public.oauth_clients, public.oauth_requests, public.oauth_grants,
  public.oauth_codes, public.oauth_tokens from anon, authenticated;

-- -------------------------------------------------------------------- RPCs

-- Dynamic client registration: at most 20 per hour per registering IP and
-- 500 per hour in total, a backstop in case the IP can be varied. One global
-- lock serialises registrations (they are rare), so neither count can race.
create or replace function public.fn_oauth_register_client(
  p_id text, p_name text, p_redirect_uris text[], p_ip_hash text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('oauth_register', 0));
  if (select count(*) from oauth_clients
       where registered_ip_hash = p_ip_hash and created_at > now() - interval '1 hour') >= 20 then
    raise exception 'rate_limited';
  end if;
  if (select count(*) from oauth_clients where created_at > now() - interval '1 hour') >= 500 then
    raise exception 'rate_limited_global';
  end if;
  insert into oauth_clients (id, client_name, redirect_uris, registered_ip_hash)
  values (p_id, p_name, p_redirect_uris, p_ip_hash);
end $$;

-- Ends a grant: the grant, every token and every unused code.
create or replace function public.fn_oauth_revoke_grant(p_grant uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_found boolean;
begin
  update oauth_grants set revoked_at = now() where id = p_grant and revoked_at is null;
  v_found := found;
  update oauth_tokens set revoked_at = now() where grant_id = p_grant and revoked_at is null;
  update oauth_codes set used_at = now() where grant_id = p_grant and used_at is null;
  return v_found;
end $$;

-- The consent page's Allow: bind the pending request to the signed-in user,
-- create or reuse the active grant, record the approved redirect URI on it,
-- issue the code, delete the request.
create or replace function public.fn_oauth_approve(p_request uuid, p_user uuid, p_code_hash text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_req oauth_requests; v_grant uuid;
begin
  delete from oauth_requests where id = p_request returning * into v_req;
  if v_req.id is null or v_req.expires_at <= now() then
    raise exception 'authorization_not_found';
  end if;
  insert into oauth_grants (user_id, client_id, approved_redirect_uris)
  values (p_user, v_req.client_id, array[v_req.redirect_uri])
  on conflict (user_id, client_id) where revoked_at is null do nothing
  returning id into v_grant;
  if v_grant is null then
    update oauth_grants
       set approved_redirect_uris = case
             when v_req.redirect_uri = any(approved_redirect_uris) then approved_redirect_uris
             else approved_redirect_uris || v_req.redirect_uri end
     where user_id = p_user and client_id = v_req.client_id and revoked_at is null
    returning id into v_grant;
  end if;
  insert into oauth_codes (code_hash, grant_id, request_id, redirect_uri, code_challenge, resource, expires_at)
  values (p_code_hash, v_grant, v_req.id, v_req.redirect_uri, v_req.code_challenge, v_req.resource,
          now() + interval '5 minutes');
  return jsonb_build_object('redirectUri', v_req.redirect_uri, 'state', v_req.state, 'clientId', v_req.client_id);
end $$;

-- authorization_code grant. A second use of a code revokes its whole grant.
-- p_challenge is BASE64URL(SHA-256(code_verifier)), computed by the gateway.
-- Locks the grant before the code, the same order as fn_oauth_revoke_grant,
-- so a Disconnect racing a redemption cannot deadlock.
create or replace function public.fn_oauth_redeem_code(
  p_code_hash text, p_client_id text, p_redirect_uri text, p_challenge text,
  p_access_hash text, p_refresh_hash text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_code oauth_codes; v_grant oauth_grants; v_grant_id uuid;
begin
  if not exists (select 1 from oauth_clients where id = p_client_id) then
    return jsonb_build_object('error', 'invalid_client');
  end if;
  select grant_id into v_grant_id from oauth_codes where code_hash = p_code_hash;
  if v_grant_id is null then
    return jsonb_build_object('error', 'invalid_grant');
  end if;
  select * into v_grant from oauth_grants where id = v_grant_id for update;
  select * into v_code from oauth_codes where code_hash = p_code_hash for update;
  if v_code.code_hash is null then
    return jsonb_build_object('error', 'invalid_grant'); -- purged between the reads
  end if;
  if v_code.used_at is not null then
    perform fn_oauth_revoke_grant(v_code.grant_id);
    return jsonb_build_object('error', 'invalid_grant', 'reuse', true,
      'grantId', v_grant.id, 'clientId', v_grant.client_id);
  end if;
  if v_grant.revoked_at is not null or v_code.expires_at <= now()
     or v_grant.client_id <> p_client_id or v_code.redirect_uri <> p_redirect_uri
     or v_code.code_challenge <> p_challenge then
    return jsonb_build_object('error', 'invalid_grant');
  end if;
  update oauth_codes set used_at = now() where code_hash = p_code_hash;
  insert into oauth_tokens (token_hash, grant_id, kind, expires_at) values
    (p_access_hash, v_grant.id, 'access', now() + interval '1 hour'),
    (p_refresh_hash, v_grant.id, 'refresh', now() + interval '30 days');
  update oauth_grants set last_used_at = now() where id = v_grant.id;
  return jsonb_build_object('grantId', v_grant.id);
end $$;

-- refresh_token grant: rotate. Presenting a rotated token revokes the grant
-- (strict: no grace window; the gateway logs each reuse). Grant first, then
-- token, the same lock order as fn_oauth_revoke_grant.
create or replace function public.fn_oauth_rotate_refresh(
  p_refresh_hash text, p_client_id text, p_access_hash text, p_new_refresh_hash text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tok oauth_tokens; v_grant oauth_grants; v_grant_id uuid;
begin
  select grant_id into v_grant_id from oauth_tokens
   where token_hash = p_refresh_hash and kind = 'refresh';
  if v_grant_id is null then
    return jsonb_build_object('error', 'invalid_grant');
  end if;
  select * into v_grant from oauth_grants where id = v_grant_id for update;
  select * into v_tok from oauth_tokens where token_hash = p_refresh_hash for update;
  if v_tok.token_hash is null then
    return jsonb_build_object('error', 'invalid_grant'); -- purged between the reads
  end if;
  if v_tok.replaced_by is not null then
    perform fn_oauth_revoke_grant(v_tok.grant_id);
    return jsonb_build_object('error', 'invalid_grant', 'reuse', true,
      'grantId', v_grant.id, 'clientId', v_grant.client_id);
  end if;
  if v_tok.revoked_at is not null or v_tok.expires_at <= now()
     or v_grant.revoked_at is not null or v_grant.client_id <> p_client_id then
    return jsonb_build_object('error', 'invalid_grant');
  end if;
  update oauth_tokens set replaced_by = p_new_refresh_hash where token_hash = p_refresh_hash;
  insert into oauth_tokens (token_hash, grant_id, kind, expires_at) values
    (p_access_hash, v_grant.id, 'access', now() + interval '1 hour'),
    (p_new_refresh_hash, v_grant.id, 'refresh', now() + interval '30 days');
  update oauth_grants set last_used_at = now() where id = v_grant.id;
  return jsonb_build_object('grantId', v_grant.id);
end $$;

-- RFC 7009. A refresh token ends the grant (the client is disconnecting); an
-- access token ends only itself. A token of another client is left alone.
create or replace function public.fn_oauth_revoke_token(p_token_hash text, p_client_id text)
returns void language plpgsql security definer set search_path = public as $$
declare v_tok oauth_tokens; v_client text;
begin
  select * into v_tok from oauth_tokens where token_hash = p_token_hash;
  if v_tok.token_hash is null then return; end if;
  select client_id into v_client from oauth_grants where id = v_tok.grant_id;
  if p_client_id is not null and p_client_id <> v_client then return; end if;
  if v_tok.kind = 'refresh' then
    perform fn_oauth_revoke_grant(v_tok.grant_id);
    return;
  end if;
  update oauth_tokens set revoked_at = coalesce(revoked_at, now()) where token_hash = p_token_hash;
end $$;

-- Connected assistants → Disconnect.
create or replace function public.fn_oauth_revoke_user_grant(p_user uuid, p_client_id text)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_grant uuid;
begin
  select id into v_grant from oauth_grants
   where user_id = p_user and client_id = p_client_id and revoked_at is null for update;
  if v_grant is null then return false; end if;
  return fn_oauth_revoke_grant(v_grant);
end $$;

-- /mcp authentication. Null unless the access token is unexpired, unrevoked
-- and its grant active. last_used_at moves at most once every 5 minutes.
create or replace function public.fn_oauth_resolve_token(p_token_hash text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_grant oauth_grants;
begin
  select g.* into v_grant from oauth_tokens t join oauth_grants g on g.id = t.grant_id
   where t.token_hash = p_token_hash and t.kind = 'access' and t.revoked_at is null
     and t.expires_at > now() and g.revoked_at is null;
  if v_grant.id is null then return null; end if;
  update oauth_grants set last_used_at = now()
   where id = v_grant.id and (last_used_at is null or last_used_at < now() - interval '5 minutes');
  return jsonb_build_object('userId', v_grant.user_id, 'clientId', v_grant.client_id, 'grantId', v_grant.id);
end $$;

-- Daily purge. Rotated refresh tokens are kept until they expire, so reuse
-- detection lasts as long as the token could have been used. A client with no
-- grant row (it never connected, or every grant was revoked and purged) goes
-- after 30 days; its assistant simply registers again.
create or replace function public.fn_oauth_purge()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_requests int; v_codes int; v_tokens int; v_grants int; v_clients int;
begin
  delete from oauth_requests where expires_at < now();
  get diagnostics v_requests = row_count;
  delete from oauth_codes where expires_at < now() - interval '1 day';
  get diagnostics v_codes = row_count;
  delete from oauth_tokens
   where expires_at < now() - interval '1 day' or revoked_at < now() - interval '1 day';
  get diagnostics v_tokens = row_count;
  delete from oauth_grants where revoked_at < now() - interval '1 day';
  get diagnostics v_grants = row_count;
  delete from oauth_clients c
   where c.created_at < now() - interval '30 days'
     and not exists (select 1 from oauth_grants g where g.client_id = c.id);
  get diagnostics v_clients = row_count;
  return jsonb_build_object('requests', v_requests, 'codes', v_codes, 'tokens', v_tokens,
    'grants', v_grants, 'clients', v_clients);
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'fn_oauth_register_client(text,text,text[],text)',
    'fn_oauth_revoke_grant(uuid)',
    'fn_oauth_approve(uuid,uuid,text)',
    'fn_oauth_redeem_code(text,text,text,text,text,text)',
    'fn_oauth_rotate_refresh(text,text,text,text)',
    'fn_oauth_revoke_token(text,text)',
    'fn_oauth_revoke_user_grant(uuid,text)',
    'fn_oauth_resolve_token(text)',
    'fn_oauth_purge()'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

select cron.schedule('purge_oauth', '20 3 * * *', $$
  select public.fn_oauth_purge();
$$);
