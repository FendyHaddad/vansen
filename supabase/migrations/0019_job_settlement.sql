-- 0019: one terminal transition per job.
--
-- Before this migration a generation could be settled from four places — the
-- inline finish in POST /generations, the poller in GET /jobs, the cancel
-- route, and the stale-job cron — each doing its own read-then-write with no
-- lock. fn_fail_job read `status` and then wrote `failed` in two statements, so
-- two concurrent settlements could both see 'pending'. The image finish path
-- did not even check the storage upload result before writing 'done'.
--
-- Everything terminal now happens here: the status flip, the refund, and the
-- notification the customer sees, in one transaction under the same advisory
-- lock fn_charge_and_generate uses.
-- (written 2026-09-20; apply AFTER 0018_billing_fulfillment.sql)

-- DEPENDENCY: fn_settle_job writes generations.storage_backend / duration_s /
-- width / height, which 0016_video.sql adds. As of 2026-09-21 that migration
-- is on disk but NOT applied to production. Fail loudly rather than create a
-- function that raises on its first real call.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'generations'
      and column_name = 'storage_backend'
  ) then
    raise exception '0019 requires 0016_video.sql — generations.storage_backend is missing';
  end if;
end $$;

alter table public.generations add column if not exists failure_code text;
alter table public.generations add column if not exists failure_message text;
alter table public.jobs add column if not exists lease_token uuid;
alter table public.jobs add column if not exists lease_until timestamptz;

-- Notifications become durable work rather than a fire-and-forget call made
-- while an HTTP response is still open.
create table if not exists public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles on delete cascade,
  generation_id uuid,
  event text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  attempts int not null default 0,
  last_error text,
  lease_token uuid,
  lease_until timestamptz,
  next_run_at timestamptz not null default now(),
  dead_letter_at timestamptz
);

create index if not exists notification_outbox_pending_idx
  on public.notification_outbox (created_at)
  where sent_at is null;

alter table public.notification_outbox enable row level security;

/**
 * Settle one job exactly once.
 *
 * p_outcome 'done'   → generation becomes done with the given media, no refund.
 * p_outcome 'failed' → generation becomes failed and the charge is refunded to
 *                      the buckets that paid, once per generation per bucket.
 *
 * Returns {settled, previous, refunded}. settled=false with previous<>'pending'
 * means someone else got there first, and the caller must clean up whatever it
 * had staged — never overwrite the winner.
 */
create or replace function public.fn_settle_job(
  p_job uuid,
  p_outcome text,
  p_media_path text default null,
  p_backend text default null,
  p_meta jsonb default '{}'::jsonb,
  p_error text default null,
  p_expected_state text default 'pending',
  p_failure_code text default null,
  p_lease_token uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_gen uuid; v_user uuid; v_status text; v_cp int; v_cpack int; v_refunded int := 0;
begin
  select j.generation_id, j.user_id into v_gen, v_user from public.jobs j where j.id = p_job;
  if v_gen is null then
    return jsonb_build_object('settled', false, 'previous', null, 'refunded', 0);
  end if;

  perform pg_advisory_xact_lock(hashtext(v_user::text));

  perform 1 from public.jobs where id = p_job for update;

  -- Read the generation FOR UPDATE so a concurrent settlement waits here
  -- rather than passing the same 'pending' check.
  select g.status, g.charged_plan, g.charged_pack
    into v_status, v_cp, v_cpack
    from public.generations g
    where g.id = v_gen
    for update;

  if p_expected_state <> 'pending' then raise exception 'invalid_expected_state'; end if;

  -- A caller that claims a lease must actually hold a live one.
  if exists (
    select 1 from public.jobs
    where id = p_job
      and (lease_token is not null or p_lease_token is not null)
      and (lease_token is distinct from p_lease_token or lease_until <= now())
  ) then
    return jsonb_build_object('settled', false, 'previous', v_status, 'refunded', 0);
  end if;

  if v_status is distinct from p_expected_state then
    return jsonb_build_object('settled', false, 'previous', v_status, 'refunded', 0);
  end if;

  if p_outcome not in ('done', 'failed') then raise exception 'invalid_outcome'; end if;

  -- 'done' without verified media is the defect this function exists to stop:
  -- a library row the customer paid for that points at nothing.
  if p_outcome = 'done' and (p_media_path is null or p_backend not in ('supabase', 'r2')) then
    raise exception 'verified_media_required';
  end if;

  if p_outcome = 'done' then
    update public.generations set
      status = 'done', failure_code = null, failure_message = null,
      media_path = coalesce(p_media_path, media_path),
      storage_backend = coalesce(p_backend, storage_backend),
      duration_s = coalesce((p_meta->>'durationS')::numeric, duration_s),
      width = coalesce((p_meta->>'width')::int, width),
      height = coalesce((p_meta->>'height')::int, height)
    where id = v_gen;
    update public.jobs set updated_at = now() where id = p_job;
    insert into public.notification_outbox (user_id, generation_id, event)
      values (v_user, v_gen, 'generation_done');
    return jsonb_build_object('settled', true, 'previous', 'pending', 'refunded', 0);
  end if;

  update public.generations set status = 'failed',
    failure_code = case
      when coalesce(p_failure_code, p_error) = 'cancelled' then 'cancelled'
      when p_failure_code in ('moderation', 'provider_error', 'timeout', 'store_failed')
        then p_failure_code
      else 'generation_failed' end,
    failure_message = case when coalesce(p_failure_code, p_error) = 'cancelled'
      then 'Cancelled · Refunded' else 'Generation failed. Your credits were refunded.' end
    where id = v_gen;
  update public.jobs set error = coalesce(p_error, 'failed'), updated_at = now() where id = p_job;

  -- ledger_refund_once (unique on note where type='refund') makes each bucket
  -- refundable exactly once per generation, however often this is called.
  if v_cp > 0 then
    insert into public.ledger_entries (user_id, type, bucket, amount_credits, note)
    values (v_user, 'refund', 'plan', v_cp, 'refund:' || v_gen::text || ':plan')
    on conflict do nothing;
    v_refunded := v_refunded + v_cp;
  end if;
  if v_cpack > 0 then
    insert into public.ledger_entries (user_id, type, bucket, amount_credits, note)
    values (v_user, 'refund', 'pack', v_cpack, 'refund:' || v_gen::text || ':pack')
    on conflict do nothing;
    v_refunded := v_refunded + v_cpack;
  end if;

  insert into public.notification_outbox (user_id, generation_id, event, payload)
    select v_user, v_gen, 'generation_failed',
           jsonb_build_object('code', coalesce(p_failure_code, 'generation_failed'))
    where coalesce(p_failure_code, p_error, '') <> 'cancelled';

  return jsonb_build_object('settled', true, 'previous', 'pending', 'refunded', v_refunded);
end $$;

-- Keep the old name during P4. P5 replaces timeout refunds with reconciliation
-- before durable provider dispatch is enabled.
create or replace function public.fn_fail_job(p_job uuid, p_error text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.fn_settle_job(p_job, 'failed', null, null, '{}'::jsonb, p_error);
end $$;

revoke execute on function public.fn_settle_job(uuid, text, text, text, jsonb, text, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.fn_settle_job(uuid, text, text, text, jsonb, text, text, text, uuid)
  to service_role;

/**
 * The outbox drainer's two halves.
 *
 * Delivery to FCM is at least once — a crash between the send and the ack
 * repeats it, which is why every push carries its row id for clients to
 * deduplicate on. The database side is exactly once: one live lease per row,
 * one sent_at, and a dead letter rather than a fake success when the retries
 * are spent.
 */
create or replace function public.fn_claim_notifications(p_limit int)
returns setof public.notification_outbox
language sql security definer set search_path = public as $$
  with picked as (
    select id from notification_outbox
    where sent_at is null and dead_letter_at is null and next_run_at <= now()
      and (lease_until is null or lease_until < now())
    order by created_at, id
    for update skip locked
    limit least(p_limit, 100)
  )
  update notification_outbox o
     set lease_token = gen_random_uuid(),
         lease_until = now() + interval '2 minutes',
         attempts = attempts + 1
    from picked
   where o.id = picked.id
  returning o.*;
$$;

create or replace function public.fn_ack_notification(
  p_id uuid,
  p_token uuid,
  p_error text default null
) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  update notification_outbox set
    sent_at = case when p_error is null then now() else null end,
    last_error = p_error,
    dead_letter_at = case when p_error is not null and attempts >= 5 then now() else null end,
    next_run_at = now() + interval '1 minute' * least(60, power(2, attempts)),
    lease_token = null,
    lease_until = null
  where id = p_id and lease_token = p_token and lease_until > now() and sent_at is null;
  return found;
end $$;

revoke all on function public.fn_claim_notifications(int) from public, anon, authenticated;
revoke all on function public.fn_ack_notification(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.fn_claim_notifications(int) to service_role;
grant execute on function public.fn_ack_notification(uuid, uuid, text) to service_role;
