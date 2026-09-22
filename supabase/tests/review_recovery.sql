-- Permanent review regressions; rollback-only, disposable database required.
begin;
do $$
declare
  u uuid := 'bbee0000-0000-4000-8000-000000000001';
  g uuid; j uuid; token uuid; n int;
begin
  insert into auth.users(id,email) values (u,'review-recovery@example.com');
  insert into public.generations(user_id,kind,status,family_id,family_name,op,prompt,media_url,price_credits)
  values(u,'image','pending','flux','FLUX','generate','test','',5) returning id into g;
  insert into public.jobs(user_id,generation_id,provider,state,updated_at)
  values(u,g,'fal','reconciling',now()-interval '1 hour') returning id into j;
  select lease_token into token from public.fn_claim_jobs(50) where id=j;
  perform public.fn_release_job(j,token,'reconciling');
  perform public.fn_check_alerts();
  assert exists(select 1 from public.alerts where kind='jobs_stuck' and resolved_at is null),
    'claim/release must not hide an hour-old uncertain job';

  assert to_regprocedure('public.fn_claim_job_save(uuid,uuid)') is not null,
    'save claims need a lease-fenced recovery boundary';
  select lease_token into token from public.fn_claim_jobs(50) where id=j;
  assert public.fn_claim_job_save(j,token), 'current lease must claim saving';
  assert not public.fn_claim_job_save(j,token), 'same lease must not double-save';
  update public.jobs set lease_until=now()-interval '1 second' where id=j;
  assert not public.fn_claim_job_save(j,token), 'expired lease must not save';
  select lease_token into token from public.fn_claim_jobs(50) where id=j;
  assert public.fn_claim_job_save(j,token), 'replacement lease must reclaim abandoned save';
  assert not public.fn_claim_job_save(j,gen_random_uuid()), 'stale worker must not save';
  for n in 1..12 loop
    assert public.fn_count_reconciliation(j,token)=n, 'reconcile attempts must increment independently';
  end loop;
end $$;
do $$
begin
  perform public.fn_raise_alert('moderation_unavailable','critical','{}');
  perform public.fn_check_alerts();
  assert exists(select 1 from public.alerts where kind='moderation_unavailable' and resolved_at is null),
    'unrelated checks must not resolve an unprobed moderation outage';
end $$;
rollback;
