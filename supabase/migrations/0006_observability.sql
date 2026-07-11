-- 0006: observability — server error log + purge cron.
-- app_errors is written only by Edge Functions (service_role); RLS deny-all
-- like every other table. Read it from the SQL editor or via Claude/MCP.

create table public.app_errors (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  source text not null default 'api',          -- api | stripe-webhook | client
  route text,                                  -- e.g. /api/generations
  method text,                                 -- GET/POST/...
  code text,                                   -- app error code, e.g. charge_failed
  message text not null,
  stack text,
  user_id uuid,                                -- no FK: keep rows after account deletion
  request_id text                              -- correlates with the client-visible 500
);

alter table public.app_errors enable row level security; -- deny-all: no policies

create index app_errors_created_at_idx on public.app_errors (created_at desc);
create index app_errors_code_idx on public.app_errors (code);

-- Errors older than 30 days are noise; purge daily (03:10 UTC, after library purge).
select cron.schedule(
  'purge_app_errors',
  '10 3 * * *',
  $$delete from public.app_errors where created_at < now() - interval '30 days'$$
);
