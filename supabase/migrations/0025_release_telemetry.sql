-- 0025: the schema version, and alerts for the failure modes P1-P8 made visible.
--
-- Numbered 0025 rather than the 0024 P9 reserved: 0024_worker_drive_guard.sql
-- was applied to the live database on 2026-09-22, and renumbering an applied
-- migration corrupts the ledger that says what ran.
--
-- Each alert below is a defect class that used to be silent. Money taken and
-- not fulfilled (P2). A generation marked done with no retrievable media (P4).
-- A job whose worker died holding it (P5). An object queued for deletion that
-- keeps failing (P6). Provider spend running away (P5). None of these queries
-- could have been written before the tables they read existed.
--
-- Delivery is deliberately NOT here. The owner chose database rows only on
-- 2026-09-22: alerts are read from the dashboard or by query, and the outbox,
-- delivery worker and webhook destination P9 describes are recorded as
-- DEFERRED in the release evidence. Nothing pages anyone; that is a known,
-- stated limitation rather than an assumed capability.
--
-- (written 2026-09-22; apply AFTER 0024_worker_drive_guard.sql)

do $$
begin
  if to_regclass('public.deletion_outbox') is null then
    raise exception '0025 requires 0021_durable_deletion.sql (deletion_outbox)';
  end if;
  if to_regclass('public.provider_expenses') is null then
    raise exception '0025 requires 0020_durable_dispatch.sql (provider_expenses)';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'fn_paid_unfulfilled'
  ) then
    raise exception '0025 requires 0018_billing_fulfillment.sql (fn_paid_unfulfilled)';
  end if;
end $$;

-- ------------------------------------------------------------ schema version

/**
 * Which migration this database is at.
 *
 * Read by `GET /manifest`, so after a deploy "is that fix live?" has an answer
 * that is not "try it and infer".
 */
create or replace function public.fn_schema_version()
returns text language sql stable security definer set search_path = public as $$
  select coalesce(max(version), 'unknown')
    from supabase_migrations.schema_migrations;
$$;

-- -------------------------------------------------------------------- alerts

create table if not exists public.alerts (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  severity text not null check (severity in ('info', 'warn', 'critical')),
  detail jsonb not null default '{}',
  -- clock_timestamp(), not now(): now() is the transaction start, so a check
  -- that observes the same problem twice inside one transaction would record
  -- both sightings at the same instant. These are observation times.
  first_seen_at timestamptz not null default clock_timestamp(),
  last_seen_at timestamptz not null default clock_timestamp(),
  resolved_at timestamptz
);
alter table public.alerts enable row level security;

-- One OPEN incident per kind, enforced by the database rather than by the
-- read-then-insert in fn_raise_alert. Two checks running concurrently would
-- otherwise both find nothing open and both insert.
create unique index if not exists one_open_alert_per_kind
  on public.alerts (kind) where resolved_at is null;

create index if not exists alerts_open_idx
  on public.alerts (last_seen_at desc) where resolved_at is null;

/**
 * Raise or refresh one alert.
 *
 * A repeat updates `last_seen_at` rather than piling up rows, so a persistent
 * problem reads as one ongoing incident with a start time -- which is the
 * thing you want at 3am -- instead of four hundred identical rows.
 */
create or replace function public.fn_raise_alert(
  p_kind text, p_severity text, p_detail jsonb
) returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.alerts (kind, severity, detail)
  values (p_kind, p_severity, p_detail)
  on conflict (kind) where resolved_at is null
  do update set last_seen_at = clock_timestamp(), detail = excluded.detail;
end $$;

/**
 * Resolve the incidents this run proved clear.
 *
 * Takes the kinds that were STILL FIRING as an argument, and resolves
 * everything else. The distinction matters: an alert must never resolve
 * because monitoring stopped running. If `fn_check_alerts` never executes,
 * nothing calls this, and every open incident stays open -- which is the
 * correct reading of "we do not know".
 */
create or replace function public.fn_resolve_checked_alerts(p_active jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  update public.alerts set resolved_at = clock_timestamp()
   where resolved_at is null
     and kind not in (select jsonb_array_elements_text(coalesce(p_active, '[]'::jsonb)));
  get diagnostics v_n = row_count;
  return v_n;
end $$;

/**
 * One monitoring pass. Returns the kinds that are currently firing.
 *
 * Every threshold here is deliberately low. These are not capacity metrics;
 * each one means a customer is already having a bad time.
 */
create or replace function public.fn_check_alerts()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_n int; v_usd numeric(14,6); v_found jsonb := '[]'::jsonb;
begin
  -- 1. Money taken, entitlement not granted. The worst outcome in the product:
  --    the customer paid and got nothing.
  select count(*) into v_n from public.fn_paid_unfulfilled(now() - interval '1 day');
  if v_n > 0 then
    perform public.fn_raise_alert('paid_unfulfilled', 'critical', jsonb_build_object('count', v_n));
    v_found := v_found || to_jsonb('paid_unfulfilled'::text);
  end if;

  -- 2. Marked done with nothing to show. Charged, and the library shows a
  --    broken tile.
  select count(*) into v_n from public.generations
   where status = 'done' and coalesce(media_path, '') = ''
     and created_at > now() - interval '7 days';
  if v_n > 0 then
    perform public.fn_raise_alert('done_without_media', 'critical', jsonb_build_object('count', v_n));
    v_found := v_found || to_jsonb('done_without_media'::text);
  end if;

  -- 3. A job nobody is working on: its lease keeps expiring, which means the
  --    worker keeps dying on it.
  select count(*) into v_n from public.jobs
   where state in ('submitting','reconciling')
     and updated_at < now() - interval '10 minutes';
  if v_n > 0 then
    perform public.fn_raise_alert('jobs_stuck', 'warn', jsonb_build_object('count', v_n));
    v_found := v_found || to_jsonb('jobs_stuck'::text);
  end if;

  -- 4. Training that stalled the same way. Separate kind, because the fix and
  --    the refund path are different.
  select count(*) into v_n from public.training_jobs
   where state in ('submitting','reconciling')
     and updated_at < now() - interval '30 minutes';
  if v_n > 0 then
    perform public.fn_raise_alert('trainings_stuck', 'warn', jsonb_build_object('count', v_n));
    v_found := v_found || to_jsonb('trainings_stuck'::text);
  end if;

  -- 5. Bytes we promised to delete and have not. A legal exposure, not a
  --    performance problem.
  select count(*) into v_n from public.deletion_outbox
   where completed_at is null and not_before <= now()
     and (attempts >= 5 or not_before < now() - interval '24 hours');
  if v_n > 0 then
    perform public.fn_raise_alert('deletion_stuck', 'critical', jsonb_build_object('count', v_n));
    v_found := v_found || to_jsonb('deletion_stuck'::text);
  end if;

  -- 6. Notifications that will never be delivered. The customer is waiting for
  --    a message that is not coming. P4 already gives up explicitly, so this
  --    reads its dead-letter mark rather than guessing from an attempt count.
  select count(*) into v_n from public.notification_outbox
   where dead_letter_at is not null and sent_at is null;
  if v_n > 0 then
    perform public.fn_raise_alert('notifications_dead', 'warn', jsonb_build_object('count', v_n));
    v_found := v_found || to_jsonb('notifications_dead'::text);
  end if;

  -- 7. Provider spend. Video is expensive enough that a loop costs real money
  --    within the hour.
  select coalesce(sum(cost), 0) into v_usd from (
    select coalesce(actual_usd, reserved_usd) as cost from public.provider_expenses
     where incurred_at > now() - interval '1 hour'
    union all
    select coalesce(actual_usd, reserved_usd) from public.training_provider_expenses
     where incurred_at > now() - interval '1 hour'
  ) expenses;
  if v_usd > 50 then
    perform public.fn_raise_alert('provider_burn', 'warn', jsonb_build_object('usd_last_hour', v_usd));
    v_found := v_found || to_jsonb('provider_burn'::text);
  end if;

  -- 8. A moderation strike surge, which usually means the gate broke open.
  select count(*) into v_n from public.moderation_events
   where created_at > now() - interval '1 hour';
  if v_n > 100 then
    perform public.fn_raise_alert('moderation_surge', 'warn', jsonb_build_object('count', v_n));
    v_found := v_found || to_jsonb('moderation_surge'::text);
  end if;

  -- Only now, having completed every check, is it safe to close anything.
  perform public.fn_resolve_checked_alerts(v_found);
  return v_found;
end $$;

select cron.unschedule(jobid) from cron.job where jobname = 'check_alerts';
select cron.schedule('check_alerts', '*/5 * * * *', $$select public.fn_check_alerts();$$);

-- Nobody holding a user JWT reads the alert stream: it names counts of other
-- people's failed payments and deletions.
revoke all on public.alerts from public, anon, authenticated;
revoke all on function public.fn_schema_version() from public, anon, authenticated;
revoke all on function public.fn_raise_alert(text, text, jsonb) from public, anon, authenticated;
revoke all on function public.fn_check_alerts() from public, anon, authenticated;
revoke all on function public.fn_resolve_checked_alerts(jsonb) from public, anon, authenticated;

grant execute on function public.fn_schema_version() to service_role;
grant execute on function public.fn_raise_alert(text, text, jsonb) to service_role;
grant execute on function public.fn_check_alerts() to service_role;
grant execute on function public.fn_resolve_checked_alerts(jsonb) to service_role;
