-- 0037: fn_reserve_persona follows the gateway's entitlement grace.
--
-- isEntitled (supabase/functions/api/services/entitlement.ts) now also needs
-- an `active` row's current_period_end to be null or later than now minus
-- 3 days: the grace covers a late renewal webhook, and past it a row whose
-- App Store EXPIRED notification never arrived stops granting access. This
-- is the only SQL function with its own copy of that rule (0032 wrote it to
-- match activePlan exactly), so it changes with it. Body otherwise identical
-- to 0032. create or replace keeps the existing grants.
--
-- Written 2026-09-24. NOT applied anywhere yet.

/** Slot capacity under the same lock as the money. Consent is recorded here. */
create or replace function public.fn_reserve_persona(
  p_user uuid, p_key uuid, p_hash text, p_name text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_existing public.submissions%rowtype;
  v_plan text; v_slots numeric; v_live int; v_persona uuid; v_result jsonb;
begin
  if p_key is null then
    raise exception 'idempotency_key_required' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtext(p_user::text));

  select * into v_existing from public.submissions
   where user_id = p_user and idempotency_key = p_key;
  if found and v_existing.body_hash <> p_hash then
    raise exception 'idempotency_conflict' using errcode = 'P0001';
  end if;
  if found then
    return v_existing.result;
  end if;

  -- The gateway's isEntitled rule exactly: anything but expired; a canceled
  -- plan (Stripe sets it on cancel-at-period-end) until its paid period ends;
  -- an active plan until 72 hours after it (late renewal webhooks; hours,
  -- not calendar days, so a session time zone's DST shift cannot move it).
  select plan into v_plan from public.subscriptions
   where user_id = p_user and status <> 'expired'
     and not (status = 'canceled' and current_period_end is not null
              and current_period_end < now())
     and not (status = 'active' and current_period_end is not null
              and current_period_end <= now() - interval '72 hours');
  if v_plan is null then
    raise exception 'subscription_required' using errcode = 'P0001';
  end if;
  v_slots := public.fn_dispatch_limit('persona_slots:' || v_plan, 0);

  select count(*) into v_live from public.personas
   where user_id = p_user and deleted_at is null and status in ('draft','ready');
  if v_live >= v_slots then
    raise exception 'slot_limit' using errcode = 'P0001';
  end if;

  insert into public.personas (user_id, name, consent_attested_at)
  values (p_user, p_name, now())
  returning id into v_persona;

  v_result := jsonb_build_object('personaId', v_persona);
  insert into public.submissions (user_id, idempotency_key, body_hash, result)
  values (p_user, p_key, p_hash, v_result);
  return v_result;
end $$;
