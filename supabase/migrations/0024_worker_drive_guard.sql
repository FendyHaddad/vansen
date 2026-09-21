-- 0024: the worker clocks check their own configuration.
--
-- 0020 and 0021 refused to apply at all when the Vault secrets naming the
-- worker endpoints were absent. The instinct was right -- a schedule installed
-- against nothing leaves paid work sitting in `ready` and leaves objects a
-- customer was told were deleted sitting in a bucket -- but the check fired in
-- the wrong place. Those secrets are per-deployment CONFIGURATION, not schema,
-- and a developer's machine has no worker to name. The assertion made
-- `supabase start` impossible, which cost every local SQL test and the whole
-- recovery-email verification: a guard that protects production by breaking
-- development is not free, and here it was the more expensive of the two.
--
-- The check moves to where someone can act on it: each tick. A tick with no
-- configuration logs a warning and returns. That is once a minute, in the
-- Postgres log a deployment already watches, rather than once at deploy time
-- in a terminal nobody keeps. Nothing is silent; nothing blocks a laptop.
--
-- (written 2026-09-22; apply AFTER 0021_durable_deletion.sql)

do $$
begin
  if to_regclass('vault.decrypted_secrets') is null then
    raise exception '0024 requires supabase vault';
  end if;
end $$;

/**
 * One tick of the generation job worker.
 *
 * Reads the endpoint from Vault rather than taking it as an argument: an
 * argument would put the worker secret in `cron.job.command`, which is a
 * readable table, and the whole point of Vault here is that the credential is
 * never in the schema.
 */
create or replace function public.fn_drive_job_worker()
returns void language plpgsql security definer set search_path = public as $$
declare v_url text; v_secret text;
begin
  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'job_worker_url';
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'job_worker_secret';

  if v_url is null or v_secret is null then
    raise warning
      'job worker not driven: vault secrets job_worker_url/job_worker_secret are missing';
    return;
  end if;

  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-worker-secret', v_secret),
    body := '{}'::jsonb);
end $$;

/** One tick of the deletion/closure worker. Same contract as above. */
create or replace function public.fn_drive_cleanup_worker()
returns void language plpgsql security definer set search_path = public as $$
declare v_url text; v_secret text;
begin
  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'cleanup_worker_url';
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'cleanup_worker_secret';

  if v_url is null or v_secret is null then
    raise warning
      'cleanup worker not driven: vault secrets cleanup_worker_url/cleanup_worker_secret are missing';
    return;
  end if;

  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-worker-secret', v_secret),
    body := '{}'::jsonb);
end $$;

-- These read Vault and post to a privileged endpoint. Nobody holding a user
-- JWT has any business calling them.
revoke all on function public.fn_drive_job_worker() from public, anon, authenticated;
revoke all on function public.fn_drive_cleanup_worker() from public, anon, authenticated;

-- Reschedule against the functions. The old commands inlined the Vault lookup
-- into `cron.job.command`; these do not, so the secret no longer appears in a
-- table at all.
select cron.unschedule(jobid) from cron.job where jobname = 'drive_job_worker';
select cron.schedule('drive_job_worker', '* * * * *',
  $$select public.fn_drive_job_worker();$$);

select cron.unschedule(jobid) from cron.job where jobname = 'drive_cleanup_worker';
select cron.schedule('drive_cleanup_worker', '*/5 * * * *',
  $$select public.fn_drive_cleanup_worker();$$);
