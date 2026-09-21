-- 0022: thumbnails for images.
--
-- Only videos had a thumb_path (a client-captured poster), so a library grid
-- of 200 images downloaded 200 full-resolution originals — hundreds of MB of
-- egress to render a page of 200x200 tiles.
-- (written 2026-09-20; apply AFTER 0021_durable_deletion.sql)

-- Rows created before this migration have no thumbnail. Rather than a
-- migration-time backfill (which would need to read every object), mark them
-- and let scripts/backfill-thumbnails.mjs work through them.
alter table public.generations
  add column if not exists thumb_state text not null default 'none'
    check (thumb_state in ('none', 'pending', 'claimed', 'ready', 'failed', 'unsupported'));

-- When the claim was taken. A run that dies mid-batch leaves rows 'claimed';
-- the next run releases anything older than its lease and tries again.
alter table public.generations
  add column if not exists thumb_claimed_at timestamptz;

update public.generations
   set thumb_state = case when coalesce(thumb_path, '') = '' then 'pending' else 'ready' end
 where status = 'done';

create index if not exists generations_thumb_backfill_idx
  on public.generations (thumb_state) where thumb_state = 'pending';

-- The backfill claims a batch the same way every other worker in this schema
-- does: skip-locked, so two runs can never pick up the same row, and each
-- claim is visible to the next one.
create or replace function public.fn_claim_thumbnails(p_limit int default 50)
returns setof public.generations
language plpgsql
security definer
set search_path = public
as $$
begin
  -- A crashed run must not strand its batch forever.
  update public.generations
     set thumb_state = 'pending', thumb_claimed_at = null
   where thumb_state = 'claimed'
     and thumb_claimed_at < now() - interval '1 hour';

  return query
  with claimed as (
    select id
      from public.generations
     where thumb_state = 'pending'
       and status = 'done'
       and kind = 'image'
       and deleted_at is null
     order by created_at desc
     limit greatest(1, least(p_limit, 200))
       for update skip locked
  )
  update public.generations g
     set thumb_state = 'claimed', thumb_claimed_at = now()
    from claimed
   where g.id = claimed.id
  returning g.*;
end;
$$;

revoke all on function public.fn_claim_thumbnails(int) from public, anon, authenticated;
grant execute on function public.fn_claim_thumbnails(int) to service_role;

-- Records the outcome of one thumbnail. A row the caller did not claim is
-- left alone: the guard is the generation id, which the caller only has
-- because fn_claim_thumbnails handed it over.
create or replace function public.fn_set_thumbnail(
  p_generation uuid,
  p_path text,
  p_state text
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_state not in ('ready', 'failed', 'unsupported') then
    raise exception 'invalid thumb_state %', p_state;
  end if;
  if p_state = 'ready' and coalesce(p_path, '') = '' then
    raise exception 'a ready thumbnail needs a path';
  end if;

  update public.generations
     set thumb_path = coalesce(p_path, thumb_path),
         thumb_state = p_state,
         thumb_claimed_at = null
   where id = p_generation
     and thumb_state = 'claimed';
end;
$$;

revoke all on function public.fn_set_thumbnail(uuid, text, text) from public, anon, authenticated;
grant execute on function public.fn_set_thumbnail(uuid, text, text) to service_role;

-- A thumbnail is an object like any other: the registry has to know about it
-- or the inventory reconciliation (P6) reports it as an orphan and the
-- cleanup worker eventually deletes it.
create or replace function public.fn_record_thumbnail(
  p_generation uuid,
  p_path text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  g record;
  v_object uuid;
begin
  select user_id, storage_backend into g
    from public.generations where id = p_generation;
  if not found then
    raise exception 'unknown generation %', p_generation;
  end if;

  v_object := public.fn_register_object(
    g.user_id,
    coalesce(g.storage_backend, 'supabase'),
    public.fn_bucket_for(coalesce(g.storage_backend, 'supabase'), 'thumb'),
    p_path,
    'thumb');
  perform public.fn_mark_object_live(v_object);
  perform public.fn_set_thumbnail(p_generation, p_path, 'ready');
end;
$$;

revoke all on function public.fn_record_thumbnail(uuid, text) from public, anon, authenticated;
grant execute on function public.fn_record_thumbnail(uuid, text) to service_role;
