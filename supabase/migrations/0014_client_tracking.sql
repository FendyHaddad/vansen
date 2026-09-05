-- 0014: client platform tracking + client error metadata.
-- Nullable everywhere: null = legacy/unknown rows, no backfill.
-- (applied 2026-07-24 via MCP apply_migration)

alter table public.generations
  add column client text check (client in ('web', 'ios', 'android'));
alter table public.personas
  add column client text check (client in ('web', 'ios', 'android'));
alter table public.app_errors
  add column client text check (client in ('web', 'ios', 'android'));
alter table public.app_errors
  add column app_version text;

-- Same body as 0008 plus the client column; signature unchanged so
-- grants/revokes from 0008 still apply.
create or replace function public.fn_charge_and_generate(
  p_user uuid, p_amount int, p_type text, p_family_id text, p_note text, p_items jsonb
) returns setof public.generations
language plpgsql security definer set search_path = public as $$
declare
  v_plan int; v_pack int; v_owner boolean;
  v_from_plan int; v_from_pack int; v_rem_plan int;
  v_item jsonb; v_price int; v_cp int;
begin
  perform pg_advisory_xact_lock(hashtext(p_user::text));
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
    values (p_user, p_type, 'plan', -v_from_plan, p_family_id, p_note);
  end if;
  if v_from_pack > 0 then
    insert into public.ledger_entries (user_id, type, bucket, amount_credits, family_id, note)
    values (p_user, p_type, 'pack', -v_from_pack, p_family_id, p_note);
  end if;
  v_rem_plan := v_from_plan;
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_price := (v_item->>'priceCredits')::int;
    v_cp := least(v_rem_plan, v_price);
    v_rem_plan := v_rem_plan - v_cp;
    return query
      insert into public.generations
        (user_id, kind, family_id, family_name, op, prompt, settings,
         price_credits, charged_plan, charged_pack, status, media_url, parent_id, client)
      values (
        p_user,
        v_item->>'kind', v_item->>'familyId', v_item->>'familyName', v_item->>'op',
        v_item->>'prompt', coalesce(v_item->'settings', '{}'::jsonb),
        v_price, v_cp, v_price - v_cp, 'pending', coalesce(v_item->>'mediaUrl', ''),
        nullif(v_item->>'parentId','')::uuid,
        nullif(v_item->>'client','')
      ) returning *;
  end loop;
end $$;