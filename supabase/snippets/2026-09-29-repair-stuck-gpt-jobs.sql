-- One-off repair, 2026-09-29: five GPT Image generations stranded in
-- `submitting`/`reconciling` with no provider reference.
--
-- Cause: the job worker ran a tick's jobs one after another on a two-minute
-- lease that nothing renewed. A 4K high GPT call (60–120 s+) still open when
-- the lease lapsed, or when the wall clock killed the isolate, could not
-- record or settle its answer, and reconciliation had no way out for an
-- inline job. Fixed in job-worker/handler.ts + _shared/jobs/dispatch.ts.
--
-- These are inline (synchronous) jobs: the only result was the answer on a
-- connection whose isolate is long gone, so no image can arrive for them now.
-- Settling them failed and refunding is the honest outcome. Cancelled ones
-- settle as `cancelled`, the rest as `timeout`.
--
-- The ids are GENERATION ids (what the MCP connector shows).
-- Run in the SQL editor as postgres. Safe to run more than once, and safe to
-- run after the fixed worker is deployed (the worker may already have settled
-- them; then step 2 settles nothing and step 3 still shows the refunds).

-- 1. Look first. Expect status 'pending', state submitting/reconciling,
--    provider_ref null (or 'inline'), charged_plan + charged_pack = 18.
select g.id as generation_id, g.status, g.charged_plan, g.charged_pack,
       j.id as job_id, j.state, j.provider_ref, j.lease_until,
       j.cancel_requested_at, j.submit_attempts, j.reconcile_attempts,
       j.progress_at, j.last_error
  from public.generations g
  join public.jobs j on j.generation_id = g.id
 where g.id in (
   '4cc8ae7a-0991-4a19-977d-9d76f24181de',
   '7355cdb6-2001-4784-985a-4054cd4f9aef',
   '85729505-bb1d-41b5-abef-02303d5b0076',
   'c1774c69-7aad-4dcb-94ee-83dbba69ae9c',
   'a874aca8-9cc6-4017-a4a7-e76a7257b034'
 )
 order by j.created_at;

-- 2. Settle. fn_settle_job refuses a job whose lease is held by someone else,
--    so only LAPSED leases are cleared; a live one means a worker is on the
--    job right now — wait a minute and re-run. The refund is written once per
--    generation and bucket (ledger_refund_once), however often this runs.
begin;

update public.jobs j
   set lease_token = null, lease_until = null
 where j.generation_id in (
   '4cc8ae7a-0991-4a19-977d-9d76f24181de',
   '7355cdb6-2001-4784-985a-4054cd4f9aef',
   '85729505-bb1d-41b5-abef-02303d5b0076',
   'c1774c69-7aad-4dcb-94ee-83dbba69ae9c',
   'a874aca8-9cc6-4017-a4a7-e76a7257b034'
 )
   and j.state <> 'done'
   and j.lease_until is not null
   and j.lease_until < now();

select g.id as generation_id,
       public.fn_settle_job(
         j.id, 'failed', null, null, '{}'::jsonb,
         case when j.cancel_requested_at is not null then 'cancelled'
              else 'inline_submit_interrupted' end,
         'pending',
         case when j.cancel_requested_at is not null then 'cancelled' else 'timeout' end,
         null
       ) as outcome
  from public.generations g
  join public.jobs j on j.generation_id = g.id
 where g.id in (
   '4cc8ae7a-0991-4a19-977d-9d76f24181de',
   '7355cdb6-2001-4784-985a-4054cd4f9aef',
   '85729505-bb1d-41b5-abef-02303d5b0076',
   'c1774c69-7aad-4dcb-94ee-83dbba69ae9c',
   'a874aca8-9cc6-4017-a4a7-e76a7257b034'
 )
   and g.status = 'pending'
   and j.state <> 'done';

commit;

-- 3. Check. Every row failed; refunds total 90 credits (18 each).
select g.id as generation_id, g.status, g.failure_code,
       coalesce(sum(l.amount_credits), 0) as refunded_credits
  from public.generations g
  left join public.ledger_entries l
    on l.type = 'refund' and l.note like 'refund:' || g.id::text || ':%'
 where g.id in (
   '4cc8ae7a-0991-4a19-977d-9d76f24181de',
   '7355cdb6-2001-4784-985a-4054cd4f9aef',
   '85729505-bb1d-41b5-abef-02303d5b0076',
   'c1774c69-7aad-4dcb-94ee-83dbba69ae9c',
   'a874aca8-9cc6-4017-a4a7-e76a7257b034'
 )
 group by g.id, g.status, g.failure_code;
