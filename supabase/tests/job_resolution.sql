begin;
do $$
declare u uuid := 'bbee0000-0000-4000-8000-000000000004'; g uuid; j uuid; token uuid;
begin
  assert to_regprocedure('public.fn_resolve_uncertain_job(uuid,text,text,text)') is not null,
    'unknown submissions require an audited operator resolution path';
  insert into auth.users(id,email) values(u,'job-resolution@example.com');
  insert into public.generations(user_id,kind,status,family_id,family_name,op,prompt,media_url,price_credits)
    values(u,'image','pending','flux','FLUX','generate','test','',5) returning id into g;
  insert into public.jobs(user_id,generation_id,provider,state) values(u,g,'fal','reconciling') returning id into j;
  select lease_token into token from public.fn_claim_jobs(50) where id=j;
  assert not public.fn_resolve_uncertain_job(j,'reference','remote-1','Provider ticket 123 confirms this request'), 'active worker must retain ownership';
  perform public.fn_release_job(j,token,'reconciling');
  assert public.fn_resolve_uncertain_job(j,'reference','remote-1','Provider ticket 123 confirms this request');
  assert (select state='submitted' and provider_ref='remote-1' from public.jobs where id=j);
  assert (select count(*) from public.job_resolution_audit where job_id=j)=1;
  assert not public.fn_resolve_uncertain_job(j,'not_submitted',null,'Do not rewind a known request');
end $$;
rollback;
