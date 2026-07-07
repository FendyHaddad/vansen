-- Vansen Foundation schema (applied 2026-07-07 via MCP execute_sql)
-- Tables are RLS deny-all: RLS enabled, zero policies for client roles.
-- Only the api Edge Function's service_role reaches data.

create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  display_name text,
  strikes int not null default 0,
  prefs jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table public.ledger_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles on delete cascade,
  type text not null check (type in ('topup','generate','edit','upscale','studio_fee','trial_credit','promo','refund')),
  amount_usd numeric(10,2) not null,
  family_id text,
  note text,
  created_at timestamptz not null default now()
);
create index ledger_entries_user_idx on public.ledger_entries (user_id, created_at desc);

create table public.generations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles on delete cascade,
  kind text not null check (kind in ('image','video')),
  family_id text not null,
  family_name text not null,
  op text not null check (op in ('generate','edit','upscale','variation')),
  prompt text not null,
  settings jsonb not null default '{}',
  price_usd numeric(10,2) not null,
  status text not null check (status in ('pending','done','failed')),
  media_url text not null,
  parent_id uuid references public.generations on delete set null,
  created_at timestamptz not null default now()
);
create index generations_user_idx on public.generations (user_id, created_at desc);

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.profiles on delete cascade,
  plan text not null check (plan in ('studio','studio_pro')),
  status text not null check (status in ('active','canceled','expired')),
  current_period_end timestamptz,
  stripe_subscription_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.ledger_entries enable row level security;
alter table public.generations enable row level security;
alter table public.subscriptions enable row level security;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id) values (new.id);
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.fn_balance(p_user uuid)
returns numeric language sql security definer set search_path = public as $$
  select coalesce(sum(amount_usd), 0) from public.ledger_entries where user_id = p_user;
$$;

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
        (v_item->>'priceUsd')::numeric, 'done', v_item->>'mediaUrl',
        nullif(v_item->>'parentId','')::uuid
      ) returning *;
  end loop;
end $$;

create or replace function public.fn_delete_account(p_user uuid)
returns void language sql security definer set search_path = public as $$
  delete from public.profiles where id = p_user;
$$;

-- Gateway posture: client roles cannot execute RPCs via PostgREST.
-- Only service_role (the api Edge Function) may call them.
revoke execute on function public.fn_balance(uuid) from public, anon, authenticated;
revoke execute on function public.fn_charge_and_generate(uuid, numeric, text, text, text, jsonb) from public, anon, authenticated;
revoke execute on function public.fn_delete_account(uuid) from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

-- service_role inherited execute via PUBLIC; regrant explicitly after the revoke.
grant execute on function public.fn_balance(uuid) to service_role;
grant execute on function public.fn_charge_and_generate(uuid, numeric, text, text, text, jsonb) to service_role;
grant execute on function public.fn_delete_account(uuid) to service_role;
alter default privileges in schema public grant execute on functions to service_role;
