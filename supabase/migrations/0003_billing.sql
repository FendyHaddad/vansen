-- Phase 2 billing schema (applied 2026-07-07 via MCP execute_sql)

alter table public.profiles add column stripe_customer_id text unique;
alter table public.ledger_entries add column stripe_ref text unique;

create table public.webhook_events (
  id text primary key,
  type text not null,
  received_at timestamptz not null default now()
);
alter table public.webhook_events enable row level security;

create extension if not exists pg_cron;

-- Day 31 after the paid period ends: library rows die; ledger never purged.
select cron.schedule(
  'purge_lapsed_libraries',
  '0 3 * * *',
  $$
  delete from public.generations g
  using public.subscriptions s
  where s.user_id = g.user_id
    and s.status in ('canceled','expired')
    and s.current_period_end < now() - interval '30 days'
  $$
);
