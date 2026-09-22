-- The inbox write commits separately from fulfillment so rollback cannot erase it.
-- The webhook opens the receipt the moment the provider signature verifies,
-- before the subscription retrieval or account lookup that can still fail, so
-- the customer may not be identified yet: user_id is filled in when it is.
alter table public.billing_deliveries add column request jsonb;
alter table public.billing_deliveries alter column user_id drop not null;

create or replace function public.fn_record_billing_delivery(
  p_source text, p_event_id text, p_txn_id text, p_user uuid, p_request jsonb
) returns void language plpgsql security definer set search_path=public as $$
begin
  insert into public.billing_deliveries(source,event_id,business_txn_id,user_id,request,attempts)
  values(p_source,p_event_id,p_txn_id,p_user,p_request,1)
  on conflict(source,event_id) do update
    set attempts=billing_deliveries.attempts+1,
        user_id=coalesce(billing_deliveries.user_id,excluded.user_id),
        request=coalesce(excluded.request,billing_deliveries.request)
    where billing_deliveries.business_txn_id=excluded.business_txn_id
      and (billing_deliveries.user_id is null
           or excluded.user_id is null
           or billing_deliveries.user_id=excluded.user_id);
  if not found then raise exception 'billing_receipt_identity_conflict'; end if;
end $$;

create or replace function public.fn_finish_billing_delivery(
  p_source text, p_event_id text, p_error text, p_user uuid default null
) returns void language plpgsql security definer set search_path=public as $$
begin
  -- A late failing concurrent attempt cannot reopen an already resolved receipt.
  update public.billing_deliveries
     set resolved_at=case when p_error is null then now() else null end,
         last_error=p_error,
         user_id=coalesce(user_id,p_user),
         next_attempt_at=case when p_error is null then next_attempt_at else now()+interval '1 minute' end
   where source=p_source and event_id=p_event_id and resolved_at is null;
end $$;

revoke all on function public.fn_record_billing_delivery(text,text,text,uuid,jsonb),
              public.fn_finish_billing_delivery(text,text,text,uuid)
  from public,anon,authenticated;
grant execute on function public.fn_record_billing_delivery(text,text,text,uuid,jsonb),
                          public.fn_finish_billing_delivery(text,text,text,uuid)
  to service_role;
