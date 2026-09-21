-- 0017: upload ownership registry.
-- The gateway signs `uploads` objects with the service-role client, which
-- bypasses storage RLS. Before this table, ownership existed only as a path
-- prefix that nothing checked on the image-reference path. Every usable upload
-- now has a row naming its owner, why it was stored, and whether moderation
-- allowed it; a path with no row cannot be referenced.
--
-- (written 2026-09-20; apply AFTER 0016_video.sql)
-- NOT APPLIED by the P1 plan. The deployed migration inventory was not read
-- when this file was written — `0016_video.sql` is recorded as unapplied as of
-- 2026-09-06 and must land first. Verify with
--   select name from supabase_migrations.schema_migrations order by version;
-- before applying this file to project bnorhcxhvxydkgvcxjad.
create table public.uploads (
  id uuid primary key default gen_random_uuid (),
  user_id uuid not null references public.profiles on delete cascade,
  path text not null unique,
  purpose text not null check (purpose in ('reference', 'persona-photo')),
  mime text not null,
  bytes int not null,
  width int not null,
  height int not null,
  moderation text not null default 'pending' check (moderation in ('pending', 'allowed', 'blocked')),
  created_at timestamptz not null default now ()
);

create index uploads_user_idx on public.uploads (user_id, created_at desc);

alter table public.uploads enable row level security;
