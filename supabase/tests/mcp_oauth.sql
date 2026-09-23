-- 0036: the authorization server's RPCs against the real schema. Code reuse and
-- refresh-token reuse revoke the whole grant; PKCE, redirect, client, expiry and
-- revocation all refuse; tokens resolve only while live; registration is capped
-- at 20 per hour per IP and 500 per hour in total; a grant records each
-- approved redirect URI; deleting the profile ends every grant; the purge
-- (including clients that never connected).
begin;
do $$
declare
  u uuid := 'aaaa0000-0000-4000-8000-00000000036a';
  cl text := 'vsn_client_aaaaaaaaaaaaaaaaaaaaaa';
  other text := 'vsn_client_bbbbbbbbbbbbbbbbbbbbbb';
  ch text := repeat('c', 43);
  req uuid; r jsonb; g uuid; n int;
  h_code text := repeat('1', 64); h_at text := repeat('2', 64); h_rt text := repeat('3', 64);
  h_at2 text := repeat('4', 64); h_rt2 text := repeat('5', 64);
begin
  assert (select relrowsecurity from pg_class where oid = 'public.oauth_tokens'::regclass),
    'oauth tables are RLS deny-all';
  assert not has_table_privilege('authenticated', 'public.oauth_tokens', 'select'),
    'token hashes are not readable by app sessions';
  assert not has_function_privilege('authenticated', 'public.fn_oauth_resolve_token(text)', 'execute'),
    'the RPCs are service_role only';

  insert into auth.users (id, email) values (u, 'oauth@example.com');
  insert into public.profiles (id, birth_date) values (u, '1990-01-01') on conflict (id) do nothing;
  perform public.fn_oauth_register_client(cl, 'Claude', array['https://claude.ai/cb'], 'ip-a');
  perform public.fn_oauth_register_client(other, 'Other', array['https://other.example/cb'], 'ip-b');

  -- Registration limit: 20 per hour per IP (ip-a already has one).
  for n in 1..19 loop
    perform public.fn_oauth_register_client('vsn_client_' || lpad(n::text, 22, 'r'), 'x', array['https://x.example/cb'], 'ip-a');
  end loop;
  begin
    perform public.fn_oauth_register_client('vsn_client_' || repeat('z', 22), 'x', array['https://x.example/cb'], 'ip-a');
    raise exception 'the 21st registration in an hour was accepted';
  exception when raise_exception then
    assert sqlerrm = 'rate_limited', 'refused as rate_limited, got ' || sqlerrm;
  end;
  perform public.fn_oauth_register_client('vsn_client_' || repeat('y', 22), 'x', array['https://x.example/cb'], 'ip-c');

  -- Global backstop: 500 per hour whatever the IP (22 so far).
  insert into public.oauth_clients (id, client_name, redirect_uris, registered_ip_hash)
  select 'vsn_client_g' || lpad(i::text, 21, '0'), 'g', array['https://g.example/cb'], 'ip-g' || i
    from generate_series(1, 478) i;
  begin
    perform public.fn_oauth_register_client('vsn_client_' || repeat('w', 22), 'x', array['https://x.example/cb'], 'ip-fresh');
    raise exception 'the 501st registration in an hour was accepted';
  exception when raise_exception then
    assert sqlerrm = 'rate_limited_global', 'refused as rate_limited_global, got ' || sqlerrm;
  end;
  delete from public.oauth_clients where id like 'vsn_client_g%';

  -- Approve: request consumed, grant created, code issued.
  insert into public.oauth_requests (client_id, redirect_uri, state, code_challenge)
  values (cl, 'https://claude.ai/cb', 's1', ch) returning id into req;
  r := public.fn_oauth_approve(req, u, h_code);
  assert r->>'redirectUri' = 'https://claude.ai/cb' and r->>'state' = 's1', 'approve returns where to send the code';
  assert not exists (select 1 from public.oauth_requests where id = req), 'the request is deleted';
  assert (select approved_redirect_uris from public.oauth_grants where user_id = u and client_id = cl)
    = array['https://claude.ai/cb'], 'the grant records the approved redirect URI';
  begin
    perform public.fn_oauth_approve(req, u, repeat('9', 64));
    raise exception 'a consumed request was approved twice';
  exception when raise_exception then
    assert sqlerrm = 'authorization_not_found';
  end;

  -- Redeem refusals leave the code usable.
  r := public.fn_oauth_redeem_code(h_code, cl, 'https://claude.ai/cb', repeat('d', 43), h_at, h_rt);
  assert r->>'error' = 'invalid_grant', 'PKCE mismatch refused';
  r := public.fn_oauth_redeem_code(h_code, cl, 'https://claude.ai/other', ch, h_at, h_rt);
  assert r->>'error' = 'invalid_grant', 'redirect mismatch refused';
  r := public.fn_oauth_redeem_code(h_code, other, 'https://claude.ai/cb', ch, h_at, h_rt);
  assert r->>'error' = 'invalid_grant', 'another client refused';
  r := public.fn_oauth_redeem_code(h_code, 'vsn_client_' || repeat('q', 22), 'https://claude.ai/cb', ch, h_at, h_rt);
  assert r->>'error' = 'invalid_client', 'unknown client';
  assert not exists (select 1 from public.oauth_tokens), 'no refusal issued a token';

  r := public.fn_oauth_redeem_code(h_code, cl, 'https://claude.ai/cb', ch, h_at, h_rt);
  g := (r->>'grantId')::uuid;
  assert g is not null, 'redeem: ' || r::text;
  r := public.fn_oauth_resolve_token(h_at);
  assert r->>'userId' = u::text and r->>'clientId' = cl and r->>'grantId' = g::text, 'access token resolves';
  assert public.fn_oauth_resolve_token(h_rt) is null, 'a refresh token is not an access token';

  -- Rotation, then reuse of the rotated token revokes the grant.
  r := public.fn_oauth_rotate_refresh(h_rt, other, h_at2, h_rt2);
  assert r->>'error' = 'invalid_grant', 'another client cannot rotate';
  r := public.fn_oauth_rotate_refresh(h_rt, cl, h_at2, h_rt2);
  assert r->>'grantId' = g::text, 'rotated';
  assert (select replaced_by from public.oauth_tokens where token_hash = h_rt) = h_rt2;
  assert public.fn_oauth_resolve_token(h_at2) is not null, 'new access token resolves';
  r := public.fn_oauth_rotate_refresh(h_rt, cl, repeat('6', 64), repeat('7', 64));
  assert r->>'error' = 'invalid_grant' and (r->>'reuse')::boolean, 'reuse refused';
  assert r->>'grantId' = g::text and r->>'clientId' = cl, 'reuse names the grant for the log: ' || r::text;
  assert (select revoked_at is not null from public.oauth_grants where id = g), 'reuse revoked the grant';
  assert public.fn_oauth_resolve_token(h_at2) is null, 'every token of the grant is dead';
  r := public.fn_oauth_rotate_refresh(h_rt2, cl, repeat('6', 64), repeat('7', 64));
  assert r->>'error' = 'invalid_grant', 'the newest refresh token died with the grant';

  -- A new approval makes a new grant; code reuse revokes it.
  insert into public.oauth_requests (id, client_id, redirect_uri, code_challenge)
  values (gen_random_uuid(), cl, 'https://claude.ai/cb', ch) returning id into req;
  perform public.fn_oauth_approve(req, u, repeat('a', 64));
  r := public.fn_oauth_redeem_code(repeat('a', 64), cl, 'https://claude.ai/cb', ch, repeat('b', 64), repeat('e', 64));
  assert (r->>'grantId')::uuid <> g, 'a revoked grant is never reused';
  g := (r->>'grantId')::uuid;
  r := public.fn_oauth_redeem_code(repeat('a', 64), cl, 'https://claude.ai/cb', ch, repeat('f', 64), repeat('0', 64));
  assert r->>'error' = 'invalid_grant' and (r->>'reuse')::boolean, 'second use refused';
  assert r->>'grantId' = g::text and r->>'clientId' = cl, 'code reuse names the grant: ' || r::text;
  assert (select revoked_at is not null from public.oauth_grants where id = g), 'code reuse revoked the grant';
  assert public.fn_oauth_resolve_token(repeat('b', 64)) is null, 'the first redemption''s token is dead';

  -- Expiry, revocation by token and by the user.
  insert into public.oauth_requests (client_id, redirect_uri, code_challenge)
  values (cl, 'https://claude.ai/cb', ch) returning id into req;
  update public.oauth_requests set expires_at = now() - interval '1 second' where id = req;
  begin
    perform public.fn_oauth_approve(req, u, repeat('8', 64));
    raise exception 'an expired request was approved';
  exception when raise_exception then
    assert sqlerrm = 'authorization_not_found';
  end;
  insert into public.oauth_requests (client_id, redirect_uri, code_challenge)
  values (cl, 'https://claude.ai/cb', ch) returning id into req;
  perform public.fn_oauth_approve(req, u, repeat('8', 64));
  update public.oauth_codes set expires_at = now() - interval '1 second' where code_hash = repeat('8', 64);
  r := public.fn_oauth_redeem_code(repeat('8', 64), cl, 'https://claude.ai/cb', ch, repeat('b', 63) || 'c', repeat('e', 63) || 'c');
  assert r->>'error' = 'invalid_grant', 'expired code refused';
  update public.oauth_codes set expires_at = now() + interval '5 minutes' where code_hash = repeat('8', 64);
  r := public.fn_oauth_redeem_code(repeat('8', 64), cl, 'https://claude.ai/cb', ch, repeat('b', 63) || 'c', repeat('e', 63) || 'c');
  g := (r->>'grantId')::uuid;
  update public.oauth_tokens set expires_at = now() - interval '1 second' where token_hash = repeat('b', 63) || 'c';
  assert public.fn_oauth_resolve_token(repeat('b', 63) || 'c') is null, 'expired access token refused';
  update public.oauth_tokens set expires_at = now() + interval '1 hour' where token_hash = repeat('b', 63) || 'c';
  perform public.fn_oauth_revoke_token(repeat('b', 63) || 'c', other);
  assert public.fn_oauth_resolve_token(repeat('b', 63) || 'c') is not null, 'another client cannot revoke it';
  perform public.fn_oauth_revoke_token(repeat('b', 63) || 'c', cl);
  assert public.fn_oauth_resolve_token(repeat('b', 63) || 'c') is null, 'revoked access token refused';
  assert (select revoked_at is null from public.oauth_grants where id = g), 'revoking an access token keeps the grant';
  perform public.fn_oauth_revoke_token(repeat('e', 63) || 'c', null);
  assert (select revoked_at is not null from public.oauth_grants where id = g), 'revoking the refresh token ends the grant';
  assert not public.fn_oauth_revoke_user_grant(u, cl), 'nothing active left to revoke';

  -- The user's Disconnect, and account deletion.
  insert into public.oauth_requests (client_id, redirect_uri, code_challenge)
  values (cl, 'https://claude.ai/cb', ch) returning id into req;
  perform public.fn_oauth_approve(req, u, repeat('d', 64));
  -- Approved redirect URIs accumulate on the active grant, once each.
  insert into public.oauth_requests (client_id, redirect_uri, code_challenge)
  values (cl, 'https://evil.example/cb', ch) returning id into req;
  perform public.fn_oauth_approve(req, u, repeat('9', 63) || 'a');
  insert into public.oauth_requests (client_id, redirect_uri, code_challenge)
  values (cl, 'https://claude.ai/cb', ch) returning id into req;
  perform public.fn_oauth_approve(req, u, repeat('9', 63) || 'b');
  assert (select approved_redirect_uris from public.oauth_grants
           where user_id = u and client_id = cl and revoked_at is null)
    = array['https://claude.ai/cb', 'https://evil.example/cb'], 'each approved URI once, in order';
  assert public.fn_oauth_revoke_user_grant(u, cl), 'disconnect revokes the active grant';
  insert into public.oauth_requests (client_id, redirect_uri, code_challenge)
  values (cl, 'https://claude.ai/cb', ch) returning id into req;
  perform public.fn_oauth_approve(req, u, repeat('d', 63) || 'e');
  r := public.fn_oauth_redeem_code(repeat('d', 63) || 'e', cl, 'https://claude.ai/cb', ch, repeat('c', 63) || 'd', repeat('c', 63) || 'e');
  assert r->>'error' is null, 'post-disconnect approval works: ' || r::text;

  -- Purge: expired requests, and codes/tokens/revoked grants a day past.
  insert into public.oauth_requests (client_id, redirect_uri, code_challenge, expires_at)
  values (cl, 'https://claude.ai/cb', ch, now() - interval '1 minute');
  update public.oauth_grants set revoked_at = now() - interval '2 days' where revoked_at is not null;
  r := public.fn_oauth_purge();
  assert (r->>'requests')::int >= 1 and (r->>'grants')::int >= 1, 'purge: ' || r::text;
  assert not exists (select 1 from public.oauth_grants where revoked_at is not null), 'old revoked grants purged';
  assert public.fn_oauth_resolve_token(repeat('c', 63) || 'd') is not null, 'live tokens survive the purge';
  assert exists (select 1 from cron.job where jobname = 'purge_oauth'), 'the purge is scheduled';

  -- Clients: one that never connected goes after 30 days; a recent one, or
  -- one with a grant, stays.
  update public.oauth_clients set created_at = now() - interval '31 days'
   where id in (cl, other, 'vsn_client_' || repeat('y', 22));
  r := public.fn_oauth_purge();
  assert (r->>'clients')::int >= 2, 'purge: ' || r::text;
  assert not exists (select 1 from public.oauth_clients where id = other), 'an old client with no grant is purged';
  assert exists (select 1 from public.oauth_clients where id = cl), 'a client with a live grant stays';
  assert exists (select 1 from public.oauth_clients where id = 'vsn_client_' || lpad('1', 22, 'r')), 'a recent client stays';

  delete from public.profiles where id = u;
  assert not exists (select 1 from public.oauth_grants where user_id = u), 'account deletion ends every grant';
  assert not exists (select 1 from public.oauth_tokens), 'and every token';
end $$;
rollback;
