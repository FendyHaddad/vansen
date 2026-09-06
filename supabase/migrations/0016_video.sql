-- 0016: video generation (spec 2026-09-05)
-- (written 2026-09-06; NOT yet applied — apply via Supabase MCP apply_migration or the dashboard SQL editor)

-- Generations: where the file lives + video metadata.
alter table public.generations
  add column if not exists storage_backend text not null default 'supabase'
    check (storage_backend in ('supabase', 'r2')),
  add column if not exists duration_s numeric(5,1),
  add column if not exists width int,
  add column if not exists height int,
  add column if not exists thumb_path text;

-- Jobs: runway provider, save-claim, live progress.
alter table public.jobs drop constraint if exists jobs_provider_check;
alter table public.jobs
  add constraint jobs_provider_check
    check (provider in ('google', 'openai', 'fal', 'runway'));

alter table public.jobs
  add column if not exists claimed_at timestamptz,
  add column if not exists progress numeric(4,3),
  add column if not exists phase text,
  add column if not exists queue_position int;

-- Kill-switch rows: video ships disabled, Pro-only. Sora is gone.
delete from public.models where id = 'sora';
insert into public.models (id, enabled, min_plan) values
  ('veo', false, 'pro'),
  ('omni', false, 'pro'),
  ('kling', false, 'pro'),
  ('runway', false, 'pro'),
  ('seedance', false, 'pro')
on conflict (id) do update set enabled = excluded.enabled, min_plan = excluded.min_plan;

-- Stale sweep: images 10 min (unchanged), videos 30 min. Also release
-- save-claims older than 10 min so a crashed finishJob can be retried.
-- Idempotent: unschedule by jobid so a fresh database (no such job) doesn't error.
select cron.unschedule(jobid) from cron.job where jobname = 'fail_stale_jobs';
select cron.schedule('fail_stale_jobs', '*/5 * * * *', $$
  update public.jobs set claimed_at = null
    where claimed_at is not null and claimed_at < now() - interval '10 minutes';
  select public.fn_fail_job(j.id, 'timeout')
    from public.jobs j
    join public.generations g on g.id = j.generation_id
    where g.status = 'pending'
      and j.error is null
      and j.created_at < now() - (
        case when g.kind = 'video' then interval '30 minutes' else interval '10 minutes' end
      );
$$);
