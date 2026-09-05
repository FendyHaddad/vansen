-- 0013: avatar personas — trained FLUX LoRA likeness (spec 2026-07-24)

create table public.personas (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles on delete cascade,
  name text not null,
  status text not null default 'draft'
    check (status in ('draft','training','ready','failed')),
  photo_paths jsonb not null default '[]',
  lora_url text,
  trigger_word text,
  provider_ref text,
  error text,
  charged_plan integer not null default 0,
  charged_pack integer not null default 0,
  training_started_at timestamptz,
  created_at timestamptz not null default now(),
  trained_at timestamptz
);
create index personas_user_idx on public.personas (user_id, created_at desc);
alter table public.personas enable row level security;

-- Kill switch row (hidden family; studio floor).
insert into public.models (id, enabled, min_plan) values ('persona', true, 'studio');

-- New ledger type for the fixed training fee.
alter table public.ledger_entries drop constraint ledger_entries_type_check;
alter table public.ledger_entries add constraint ledger_entries_type_check
  check (type in ('generate','edit','upscale','refund','pack_purchase','cycle_reset',
                  'pack_expiry','promo','persona_training'));

-- Charge training: plan bucket first, then pack (mirrors fn_charge_and_generate).
create or replace function public.fn_charge_persona(p_user uuid, p_persona uuid, p_amount int)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_plan int; v_pack int; v_owner boolean; v_from_plan int; v_from_pack int; v_status text;
begin
  perform pg_advisory_xact_lock(hashtext(p_user::text));
  select status into v_status from public.personas where id = p_persona and user_id = p_user;
  if v_status is null or v_status not in ('draft','failed') then
    raise exception 'invalid_persona_status' using errcode = 'P0001';
  end if;
  select exists (
    select 1 from public.subscriptions
    where user_id = p_user and plan = 'owner' and status = 'active'
  ) into v_owner;
  select bal.plan_credits, bal.pack_credits into v_plan, v_pack
    from public.fn_balances(p_user) bal;
  if not v_owner and v_plan + v_pack < p_amount then
    raise exception 'insufficient_balance' using errcode = 'P0001';
  end if;
  v_from_plan := case when v_owner then p_amount else least(greatest(v_plan, 0), p_amount) end;
  v_from_pack := p_amount - v_from_plan;
  if v_from_plan > 0 then
    insert into public.ledger_entries (user_id, type, bucket, amount_credits, family_id, note)
    values (p_user, 'persona_training', 'plan', -v_from_plan, 'persona', 'Persona training');
  end if;
  if v_from_pack > 0 then
    insert into public.ledger_entries (user_id, type, bucket, amount_credits, family_id, note)
    values (p_user, 'persona_training', 'pack', -v_from_pack, 'persona', 'Persona training');
  end if;
  update public.personas
    set status = 'training', error = null,
        charged_plan = v_from_plan, charged_pack = v_from_pack,
        training_started_at = now()
    where id = p_persona;
end $$;

-- Fail + refund once per bucket (ledger_refund_once covers the notes).
create or replace function public.fn_fail_persona(p_persona uuid, p_error text)
returns void language plpgsql security definer set search_path = public as $$
declare v_user uuid; v_status text; v_cp int; v_cpack int;
begin
  select user_id, status, charged_plan, charged_pack into v_user, v_status, v_cp, v_cpack
    from public.personas where id = p_persona;
  if v_status is distinct from 'training' then return; end if;
  update public.personas set status = 'failed', error = p_error where id = p_persona;
  if v_cp > 0 then
    insert into public.ledger_entries (user_id, type, bucket, amount_credits, note)
    values (v_user, 'refund', 'plan', v_cp, 'refund:persona:' || p_persona::text || ':plan')
    on conflict do nothing;
  end if;
  if v_cpack > 0 then
    insert into public.ledger_entries (user_id, type, bucket, amount_credits, note)
    values (v_user, 'refund', 'pack', v_cpack, 'refund:persona:' || p_persona::text || ':pack')
    on conflict do nothing;
  end if;
end $$;

revoke execute on function public.fn_charge_persona(uuid, uuid, int) from public, anon, authenticated;
revoke execute on function public.fn_fail_persona(uuid, text) from public, anon, authenticated;
grant execute on function public.fn_charge_persona(uuid, uuid, int) to service_role;
grant execute on function public.fn_fail_persona(uuid, text) to service_role;

-- Training runs ~2–5 min; sweep anything stuck past 30.
select cron.schedule('fail_stale_persona_trainings', '*/5 * * * *', $$
  select public.fn_fail_persona(p.id, 'timeout')
  from public.personas p
  where p.status = 'training' and p.training_started_at < now() - interval '30 minutes'
$$);

-- Same-name reschedule replaces the job: lapsed purge now also drops personas.
select cron.schedule('purge_lapsed_libraries', '0 3 * * *', $$
  delete from public.generations g
  using public.subscriptions s
  where s.user_id = g.user_id
    and s.status in ('canceled','expired')
    and s.current_period_end < now() - interval '30 days';
  delete from public.personas p
  using public.subscriptions s
  where s.user_id = p.user_id
    and s.status in ('canceled','expired')
    and s.current_period_end < now() - interval '30 days'
$$);
