begin;
do $$
declare u uuid := 'bbee0000-0000-4000-8000-000000000002'; n int;
begin
  assert to_regprocedure('public.fn_record_billing_delivery(text,text,text,uuid,jsonb)') is not null,
    'verified receipts need a durable runtime writer';
  perform public.fn_record_billing_delivery('stripe','evt_receipt','in_receipt',u,'{"kind":"pack_grant"}');
  perform public.fn_finish_billing_delivery('stripe','evt_receipt','connection reset');
  assert (select attempts=1 and resolved_at is null and last_error='connection reset'
          from public.billing_deliveries where event_id='evt_receipt');
  update public.billing_deliveries set next_attempt_at=now() where event_id='evt_receipt';
  assert exists(select 1 from public.fn_paid_unfulfilled(now()-interval '1 day') where business_txn_id='in_receipt');
  perform public.fn_record_billing_delivery('stripe','evt_receipt','in_receipt',u,'{"kind":"pack_grant"}');
  perform public.fn_finish_billing_delivery('stripe','evt_receipt',null);
  perform public.fn_finish_billing_delivery('stripe','evt_receipt','late failed attempt');
  assert (select attempts=2 and resolved_at is not null and last_error is null
          from public.billing_deliveries where event_id='evt_receipt'), 'late failure reopened success';

  -- Opened at the webhook boundary before the customer is known; identified on settle.
  perform public.fn_record_billing_delivery('stripe','evt_anon','in_anon',null,'{"type":"invoice.paid"}');
  assert (select user_id is null and resolved_at is null from public.billing_deliveries where event_id='evt_anon');
  assert exists(select 1 from public.fn_paid_unfulfilled(now()-interval '1 day') where business_txn_id='in_anon'),
    'an unidentified verified payment must still be reported';
  perform public.fn_finish_billing_delivery('stripe','evt_anon',null,u);
  assert (select user_id=u and resolved_at is not null from public.billing_deliveries where event_id='evt_anon'),
    'the customer learned late must be recorded';

  -- Unfulfillable (no user id on the event) stays open and reported.
  perform public.fn_record_billing_delivery('stripe','evt_orphan','cs_orphan',null,'{"type":"checkout.session.completed"}');
  perform public.fn_finish_billing_delivery('stripe','evt_orphan','unfulfillable:no_user_id');
  assert (select resolved_at is null and last_error='unfulfillable:no_user_id'
          from public.billing_deliveries where event_id='evt_orphan');

  -- The same event id may never be re-recorded against a different transaction.
  begin
    perform public.fn_record_billing_delivery('stripe','evt_receipt','in_other',u,'{}');
    raise exception 'identity_conflict_not_detected';
  exception when others then
    if sqlerrm<>'billing_receipt_identity_conflict' then raise; end if;
  end;
end $$;
rollback;
