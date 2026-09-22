begin;
do $$
declare u uuid := 'bbee0000-0000-4000-8000-000000000003'; n int; r jsonb;
begin
  assert to_regprocedure('public.fn_take_request_slot(uuid,text)') is not null, 'request budgets must be durable across API instances';
  insert into auth.users(id,email) values(u,'rate-limit@example.com');
  for n in 1..20 loop
    r := public.fn_take_request_slot(u,'generation');
    assert (r->>'allowed')::boolean, 'normal requests must fit the minute budget';
  end loop;
  r := public.fn_take_request_slot(u,'generation');
  assert not (r->>'allowed')::boolean, '21st generation request must be refused';
  assert (r->>'retryAfterSeconds')::int between 1 and 60;
  r := public.fn_take_request_slot(u,'upload');
  assert (r->>'allowed')::boolean, 'upload budget is independent';
  update public.request_rate_limits set window_started_at=now()-interval '2 minutes' where user_id=u;
  r := public.fn_take_request_slot(u,'generation');
  assert (r->>'allowed')::boolean, 'expired window must recover';
end $$;
rollback;
