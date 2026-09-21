-- Real-database ownership/RLS gate for the upload registry (0017).
--
-- The gateway reaches `uploads` with the service-role client, which bypasses
-- RLS. This file proves the OTHER half: that a client role holding a user's JWT
-- cannot read, forge or relabel a registry row — so the resolver's owner check
-- is not the only thing standing between a caller and someone else's image.
--
-- How to run:
--
--   supabase start
--   export VANSEN_LOCAL_DB=postgresql://postgres:postgres@127.0.0.1:54322/postgres
--   psql "$VANSEN_LOCAL_DB" -X -v ON_ERROR_STOP=1 -f supabase/tests/upload_ownership.sql
--
-- The hand-rolled `docker run` recipe this header used to carry is obsolete:
-- `supabase start` works again as of 2026-09-22 and applies every migration,
-- so the auth/storage shims it needed are no longer required.
--
-- Every fixture is rolled back: the file runs inside one transaction and ends
-- with `rollback`.

\set ON_ERROR_STOP on
\timing off

begin;

-- ---------------------------------------------------------------- fixtures --
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'a@test.invalid'),
  ('00000000-0000-0000-0000-00000000000b', 'b@test.invalid');

-- A trigger on auth.users may already have created these; either way they exist.
insert into public.profiles (id, display_name) values
  ('00000000-0000-0000-0000-00000000000a', 'user a'),
  ('00000000-0000-0000-0000-00000000000b', 'user b')
on conflict (id) do nothing;

-- A owns one allowed reference and one still-pending one; B owns an allowed
-- reference and an allowed persona photo. Service-role writes them, as the
-- gateway does.
insert into public.uploads (user_id, path, purpose, mime, bytes, width, height, moderation) values
  ('00000000-0000-0000-0000-00000000000a',
   '00000000-0000-0000-0000-00000000000a/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png',
   'reference', 'image/png', 1024, 512, 512, 'allowed'),
  ('00000000-0000-0000-0000-00000000000a',
   '00000000-0000-0000-0000-00000000000a/cccccccc-cccc-4ccc-8ccc-cccccccccccc.png',
   'reference', 'image/png', 1024, 512, 512, 'pending'),
  ('00000000-0000-0000-0000-00000000000b',
   '00000000-0000-0000-0000-00000000000b/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.png',
   'reference', 'image/png', 1024, 512, 512, 'allowed'),
  ('00000000-0000-0000-0000-00000000000b',
   '00000000-0000-0000-0000-00000000000b/dddddddd-dddd-4ddd-8ddd-dddddddddddd.png',
   'persona-photo', 'image/png', 1024, 512, 512, 'allowed');

-- ------------------------------------------------- service_role can see all --
do $$
begin
  if (select count(*) from public.uploads) <> 4 then
    raise exception 'service_role could not read the registry it just wrote';
  end if;
end $$;

-- ------------------------------------------------ constraints are enforced --
do $$
begin
  begin
    insert into public.uploads (user_id, path, purpose, mime, bytes, width, height)
    values ('00000000-0000-0000-0000-00000000000a', 'x/y.png', 'not-a-purpose',
            'image/png', 1, 1, 1);
    raise exception 'purpose check constraint did not fire';
  exception when check_violation then null;
  end;

  begin
    insert into public.uploads (user_id, path, purpose, mime, bytes, width, height, moderation)
    values ('00000000-0000-0000-0000-00000000000a', 'x/y2.png', 'reference',
            'image/png', 1, 1, 1, 'approved');
    raise exception 'moderation check constraint did not fire';
  exception when check_violation then null;
  end;

  begin
    insert into public.uploads (user_id, path, purpose, mime, bytes, width, height)
    values ('00000000-0000-0000-0000-00000000000b',
            '00000000-0000-0000-0000-00000000000a/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png',
            'reference', 'image/png', 1, 1, 1);
    raise exception 'path uniqueness did not fire — two owners could claim one object';
  exception when unique_violation then null;
  end;

  begin
    insert into public.uploads (user_id, path, purpose, mime, bytes, width, height)
    values ('00000000-0000-0000-0000-0000000000ff', 'ghost/y.png', 'reference',
            'image/png', 1, 1, 1);
    raise exception 'user_id FK did not fire — an upload could outlive its owner';
  exception when foreign_key_violation then null;
  end;
end $$;

-- ------------------------------------------------------ A, as authenticated --
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}',
  true
);

-- Deny-all is enforced at BOTH layers here: `authenticated` holds no grant on
-- public.uploads at all, so a read raises insufficient_privilege rather than
-- returning zero rows. Either outcome is a pass; returning a row is not.
do $$
declare
  leaked int;
begin
  begin
    select count(*) into leaked from public.uploads;
    if leaked > 0 then
      raise exception 'RLS exposed % upload row(s) to an authenticated client role', leaked;
    end if;
  exception when insufficient_privilege then null;
  end;

  begin
    select count(*) into leaked from public.uploads
     where user_id = '00000000-0000-0000-0000-00000000000b';
    if leaked > 0 then raise exception 'RLS exposed foreign upload'; end if;
  exception when insufficient_privilege then null;
  end;

  -- A cannot mark anything allowed, rewrite ownership, relabel a purpose,
  -- delete a foreign row, or forge an allowed one.
  begin
    update public.uploads set moderation = 'allowed'
     where path = '00000000-0000-0000-0000-00000000000a/cccccccc-cccc-4ccc-8ccc-cccccccccccc.png';
    if found then raise exception 'authenticated user promoted a pending upload to allowed'; end if;
  exception when insufficient_privilege then null;
  end;

  begin
    update public.uploads set user_id = '00000000-0000-0000-0000-00000000000a'
     where user_id = '00000000-0000-0000-0000-00000000000b';
    if found then raise exception 'authenticated user rewrote upload ownership'; end if;
  exception when insufficient_privilege then null;
  end;

  begin
    update public.uploads set purpose = 'reference' where purpose = 'persona-photo';
    if found then raise exception 'authenticated user relabelled an upload purpose'; end if;
  exception when insufficient_privilege then null;
  end;

  begin
    delete from public.uploads where user_id = '00000000-0000-0000-0000-00000000000b';
    if found then raise exception 'authenticated user deleted a foreign upload'; end if;
  exception when insufficient_privilege then null;
  end;

  begin
    insert into public.uploads (user_id, path, purpose, mime, bytes, width, height, moderation)
    values ('00000000-0000-0000-0000-00000000000a', 'forged/forged.png', 'reference',
            'image/png', 1, 1, 1, 'allowed');
    raise exception 'authenticated user forged an allowed registry row';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;

-- --------------------------------------------------------------- anon role --
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);

do $$
declare
  leaked int;
begin
  begin
    select count(*) into leaked from public.uploads;
    if leaked > 0 then raise exception 'anon read % row(s) of the upload registry', leaked; end if;
  exception when insufficient_privilege then null;
  end;

  begin
    insert into public.uploads (user_id, path, purpose, mime, bytes, width, height)
    values ('00000000-0000-0000-0000-00000000000a', 'anon/anon.png', 'reference',
            'image/png', 1, 1, 1);
    raise exception 'anon wrote to the upload registry';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;

-- --------------------------- service_role still sees everything afterwards --
do $$
begin
  if (select count(*) from public.uploads) <> 4 then
    raise exception 'client roles mutated the registry after all';
  end if;
  if (select moderation from public.uploads
      where path = '00000000-0000-0000-0000-00000000000a/cccccccc-cccc-4ccc-8ccc-cccccccccccc.png')
     <> 'pending' then
    raise exception 'the pending upload was promoted';
  end if;
end $$;

\echo 'upload_ownership: PASS'

rollback;
