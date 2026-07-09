-- Phase 3a generation schema (applied 2026-07-09 via MCP execute_sql)
-- jobs (async work tickets), models (kill switch), moderation_events (appeal evidence),
-- media_path on generations, atomic fail/refund + strike RPCs, private storage buckets.

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  generation_id uuid not null references public.generations on delete cascade,
  user_id uuid not null references public.profiles on delete cascade,
  provider text not null check (provider in ('google','openai','fal')),
  provider_ref text,
  attempts int not null default 0,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index jobs_user_idx on public.jobs (user_id, created_at desc);
create index jobs_generation_idx on public.jobs (generation_id);
create index jobs_pending_idx on public.jobs (created_at) where error is null and provider_ref is not null;

create table public.models (
  id text primary key,
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

create table public.moderation_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles on delete cascade,
  source text not null check (source in ('prompt','upload')),
  prompt text,
  quarantine_path text,
  categories jsonb not null default '{}',
  resolution text,               -- null = unreviewed; 'upheld' | 'overturned: <note>'
  created_at timestamptz not null default now()
);
create index moderation_user_idx on public.moderation_events (user_id, created_at desc);

alter table public.generations add column media_path text;

alter table public.jobs enable row level security;
alter table public.models enable row level security;
alter table public.moderation_events enable row level security;

-- Refund runs exactly once per generation.
create unique index ledger_refund_once on public.ledger_entries (note) where type = 'refund';

-- Availability: image families + upscaler on, video off (phase 3b flips them).
insert into public.models (id, enabled) values
  ('nano-banana', true), ('gpt-image', true), ('flux', true), ('seedream', true),
  ('upscaler', true),
  ('veo', false), ('sora', false), ('kling', false), ('runway', false), ('seedance', false);

-- Atomic technical-failure handler: mark generation failed, save job error, refund once.
create or replace function public.fn_fail_job(p_job uuid, p_error text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_gen uuid; v_user uuid; v_price numeric; v_status text;
begin
  select j.generation_id, j.user_id into v_gen, v_user from public.jobs j where j.id = p_job;
  if v_gen is null then return; end if;
  update public.jobs set error = p_error, updated_at = now() where id = p_job;
  select status, price_usd into v_status, v_price from public.generations where id = v_gen;
  if v_status is distinct from 'pending' then return; end if;
  update public.generations set status = 'failed' where id = v_gen;
  insert into public.ledger_entries (user_id, type, amount_usd, note)
  values (v_user, 'refund', v_price, 'refund:' || v_gen::text)
  on conflict do nothing;
end $$;

create or replace function public.fn_increment_strike(p_user uuid)
returns void language sql security definer set search_path = public as $$
  update public.profiles set strikes = strikes + 1 where id = p_user;
$$;

revoke execute on function public.fn_fail_job(uuid, text) from public, anon, authenticated;
revoke execute on function public.fn_increment_strike(uuid) from public, anon, authenticated;
grant execute on function public.fn_fail_job(uuid, text) to service_role;
grant execute on function public.fn_increment_strike(uuid) to service_role;

-- Private storage. Outputs in media/{userId}/{genId}.png, references in uploads/{userId}/{uuid}.
insert into storage.buckets (id, name, public) values
  ('media', 'media', false), ('uploads', 'uploads', false)
on conflict (id) do nothing;

-- Timeout sweep: jobs pending > 10 min → failed + refund (appended in Task 5).
select cron.schedule('fail_stale_jobs', '*/5 * * * *', $$
  select public.fn_fail_job(j.id, 'timeout')
  from public.jobs j
  join public.generations g on g.id = j.generation_id
  where g.status = 'pending' and j.created_at < now() - interval '10 minutes'
$$);

-- Real pipeline: generations start 'pending'; provider jobs flip them done/failed.
-- (Replaces the placeholder-era version from 0001 that inserted 'done'.)
create or replace function public.fn_charge_and_generate(
  p_user uuid, p_amount numeric, p_type text, p_family_id text, p_note text, p_items jsonb
) returns setof public.generations
language plpgsql security definer set search_path = public as $$
declare
  v_balance numeric;
  v_item jsonb;
begin
  perform pg_advisory_xact_lock(hashtext(p_user::text));
  select coalesce(sum(amount_usd), 0) into v_balance from public.ledger_entries where user_id = p_user;
  if v_balance < p_amount then
    raise exception 'insufficient_balance' using errcode = 'P0001';
  end if;
  insert into public.ledger_entries (user_id, type, amount_usd, family_id, note)
  values (p_user, p_type, -p_amount, p_family_id, p_note);
  for v_item in select * from jsonb_array_elements(p_items) loop
    return query
      insert into public.generations
        (user_id, kind, family_id, family_name, op, prompt, settings, price_usd, status, media_url, parent_id)
      values (
        p_user,
        v_item->>'kind', v_item->>'familyId', v_item->>'familyName', v_item->>'op',
        v_item->>'prompt', coalesce(v_item->'settings', '{}'::jsonb),
        (v_item->>'priceUsd')::numeric, 'pending', coalesce(v_item->>'mediaUrl', ''),
        nullif(v_item->>'parentId','')::uuid
      ) returning *;
  end loop;
end $$;
