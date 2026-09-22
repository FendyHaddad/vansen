-- Service-role operators can attach confirmed references or confirm non-submission.
-- No time-based assumption refunds or resubmits ambiguous paid work.
create table public.job_resolution_audit (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  action text not null check(action in ('reference','not_submitted')),
  provider_ref text,
  evidence text not null,
  resolved_at timestamptz not null default now()
);
alter table public.job_resolution_audit enable row level security;

create or replace function public.fn_resolve_uncertain_job(
  p_job uuid,p_action text,p_provider_ref text,p_evidence text
) returns boolean language plpgsql security definer set search_path=public as $$
declare j public.jobs;
begin
  if p_action not in ('reference','not_submitted') or length(trim(coalesce(p_evidence,'')))<10 then
    raise exception 'resolution_requires_action_and_provider_evidence';
  end if;
  if p_action='reference' and (nullif(trim(p_provider_ref),'') is null or p_provider_ref='inline') then
    raise exception 'resolution_requires_pollable_reference';
  end if;
  select * into j from public.jobs where id=p_job for update;
  if not found or j.state not in ('submitting','reconciling')
    or j.lease_until>now() then return false; end if;
  if p_action='not_submitted' and j.provider_ref is not null then
    raise exception 'saved_reference_cannot_be_resubmitted';
  end if;
  update public.jobs set state=case p_action when 'reference' then 'submitted' else 'ready' end,
    provider_ref=case p_action when 'reference' then p_provider_ref else null end,
    lease_token=null,lease_until=null,claimed_at=null,save_lease_token=null,
    reconcile_attempts=0,next_run_at=now(),last_error=null,updated_at=now()
    where id=p_job;
  insert into public.job_resolution_audit(job_id,action,provider_ref,evidence)
    values(p_job,p_action,p_provider_ref,p_evidence);
  return true;
end $$;
revoke all on function public.fn_resolve_uncertain_job(uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.fn_resolve_uncertain_job(uuid,text,text,text) to service_role;
