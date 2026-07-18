-- P3 push: FCM device tokens, one row per (user, token). RLS deny-all
-- (gateway-only via service role), matching every other table.
-- (applied 2026-07-18 via MCP execute_sql)
create table public.devices (
  user_id uuid not null references public.profiles on delete cascade,
  token text not null,
  platform text not null check (platform in ('ios', 'android')),
  created_at timestamptz not null default now (),
  updated_at timestamptz not null default now (),
  primary key (user_id, token)
);

alter table public.devices enable row level security;
