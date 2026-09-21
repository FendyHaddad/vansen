-- Durable deletion: the bytes go, the money history stays, and nothing is
-- reported as removed that has not been removed. LOCAL DATABASE ONLY.
-- See supabase/tests/upload_ownership.sql for the recipe.
--
-- Every number asserted here comes from
-- docs/superpowers/specs/2026-09-20-retention-policy.md (decision D2).
begin;

create or replace function pg_temp.seed_user(p_user uuid, p_email text)
returns void language plpgsql as $$
begin
  insert into auth.users (id, email) values (p_user, p_email) on conflict do nothing;
  insert into public.profiles (id, birth_date) values (p_user, '1990-01-01') on conflict do nothing;
  insert into public.subscriptions (user_id, plan, status, current_period_end)
  values (p_user, 'pro', 'active', now() + interval '30 days')
  on conflict (user_id) do update set status = 'active', current_period_end = now() + interval '30 days';
  insert into public.ledger_entries (user_id, type, bucket, amount_credits, note)
  values (p_user, 'cycle_reset', 'plan', 1000, 'seed ' || p_user::text);
end $$;

/** An image generation with media on Supabase. */
create or replace function pg_temp.seed_image(p_user uuid, p_id uuid)
returns void language sql as $$
  insert into public.generations
    (id, user_id, kind, family_id, family_name, op, prompt, settings,
     price_credits, status, media_url, media_path, storage_backend)
  values (p_id, p_user, 'image', 'flux', 'FLUX', 'generate', 'a cat', '{}'::jsonb,
          40, 'done', '', p_user::text || '/' || p_id::text || '.png', 'supabase');
$$;

/** A video with its media AND its poster in R2. */
create or replace function pg_temp.seed_video(p_user uuid, p_id uuid)
returns void language sql as $$
  insert into public.generations
    (id, user_id, kind, family_id, family_name, op, prompt, settings,
     price_credits, status, media_url, media_path, thumb_path, storage_backend)
  values (p_id, p_user, 'video', 'kling', 'Kling', 'generate', 'a cat', '{}'::jsonb,
          100, 'done', '',
          'videos/' || p_user::text || '/' || p_id::text || '.mp4',
          'videos/' || p_user::text || '/' || p_id::text || '.jpg', 'r2');
$$;

create or replace function pg_temp.seed_persona(p_user uuid, p_id uuid, p_lora text)
returns void language sql as $$
  insert into public.personas (id, user_id, name, status, photo_paths, lora_url, trigger_word)
  values (p_id, p_user, 'Ada', 'ready',
          jsonb_build_array(p_user::text || '/photo-1.jpg', p_user::text || '/photo-2.jpg'),
          p_lora, 'VNSNPRSN');
$$;

create or replace function pg_temp.locator(p_backend text, p_bucket text, p_path text)
returns text language sql stable as $$
  select state from public.storage_objects
   where backend = p_backend and bucket = p_bucket and path = p_path;
$$;

-- R2 objects need the bucket name the deployment actually uses.
insert into public.storage_config (key, value) values ('r2_bucket', 'vansen-test')
on conflict (key) do update set value = 'vansen-test';

-- 1. Deleting one image queues its object with its EXACT bucket, and the row
--    is gone in the same transaction.
do $$
declare
  v_user uuid := 'eeee0000-0000-4000-8000-000000000001';
  v_gen uuid := 'eeee1111-0000-4000-8000-000000000001';
  v_path text;
begin
  perform pg_temp.seed_user(v_user, 'del1@example.com');
  perform pg_temp.seed_image(v_user, v_gen);
  v_path := v_user::text || '/' || v_gen::text || '.png';

  perform public.fn_delete_generation(v_user, v_gen);

  assert not exists (select 1 from public.generations where id = v_gen),
    'the row must be gone';
  assert (select count(*) from public.deletion_outbox
           where backend = 'supabase' and bucket = 'media' and object_path = v_path
             and completed_at is null) = 1,
    'the object must be queued in the media bucket, by name';
  assert pg_temp.locator('supabase', 'media', v_path) = 'delete_pending';
end $$;

-- 2. The same key in a different bucket is a different object. A delete aimed
--    at an upload must not touch the identically-named media object.
do $$
declare
  v_user uuid := 'eeee0000-0000-4000-8000-000000000002';
  v_same text := 'eeee0000-0000-4000-8000-000000000002/collision.png';
  v_upload uuid;
begin
  perform pg_temp.seed_user(v_user, 'del2@example.com');
  perform public.fn_register_object(v_user, 'supabase', 'media', v_same, 'media');
  v_upload := public.fn_register_object(v_user, 'supabase', 'uploads', v_same, 'upload');

  perform public.fn_enqueue_deletions(to_jsonb(array[v_upload]), 'test');

  assert pg_temp.locator('supabase', 'uploads', v_same) = 'delete_pending';
  assert pg_temp.locator('supabase', 'media', v_same) = 'staged',
    'a bucket-blind delete would have taken the media object too';
  assert (select count(*) from public.deletion_outbox where object_path = v_same) = 1;
end $$;

-- 3. A video queues BOTH its file and its poster, in R2, under the configured
--    bucket — never a presumed Supabase one.
do $$
declare
  v_user uuid := 'eeee0000-0000-4000-8000-000000000003';
  v_gen uuid := 'eeee1111-0000-4000-8000-000000000003';
begin
  perform pg_temp.seed_user(v_user, 'del3@example.com');
  perform pg_temp.seed_video(v_user, v_gen);

  perform public.fn_delete_generation(v_user, v_gen);

  assert (select count(*) from public.deletion_outbox
           where backend = 'r2' and bucket = 'vansen-test' and completed_at is null) = 2,
    'the video and its poster both belong to R2';
  assert not exists (
    select 1 from public.deletion_outbox where backend = 'supabase' and object_path like 'videos/%'
  ), 'nothing about an R2 video may be queued against Supabase';
end $$;

-- 4. A persona takes its photos and its ZIP, and records the provider-hosted
--    LoRA as a REQUEST — we do not hold those bytes.
do $$
declare
  v_user uuid := 'eeee0000-0000-4000-8000-000000000004';
  v_persona uuid := 'eeee2222-0000-4000-8000-000000000004';
begin
  perform pg_temp.seed_user(v_user, 'del4@example.com');
  perform pg_temp.seed_persona(v_user, v_persona, 'https://fal.example/lora/abc.safetensors');

  perform public.fn_delete_persona(v_user, v_persona);

  assert (select count(*) from public.deletion_outbox
           where bucket = 'uploads' and reason = 'persona_deleted' and completed_at is null) = 3,
    'two photos and one ZIP';
  assert (select status from public.provider_artifact_deletions
           where artifact_ref = 'https://fal.example/lora/abc.safetensors') = 'requested';
  assert not exists (
    select 1 from public.deletion_outbox where object_path like 'https://%'
  ), 'a provider URL is not something a local delete may ever receive';
  assert not exists (select 1 from public.personas where id = v_persona);
end $$;

-- 5. Work that is still running is tombstoned, asked to stop, and KEPT until
--    it settles. The provider may still hand us bytes.
do $$
declare
  v_user uuid := 'eeee0000-0000-4000-8000-000000000005';
  v_gen uuid := 'eeee1111-0000-4000-8000-000000000005';
  v_out jsonb;
begin
  perform pg_temp.seed_user(v_user, 'del5@example.com');
  perform pg_temp.seed_image(v_user, v_gen);
  update public.generations set status = 'pending' where id = v_gen;
  insert into public.jobs (user_id, generation_id, provider, state)
  values (v_user, v_gen, 'fal', 'submitted');

  v_out := public.fn_delete_generation(v_user, v_gen);

  assert v_out->>'status' = 'pending_job', format('got %s', v_out);
  assert (select deleted_at is not null from public.generations where id = v_gen),
    'the customer sees it gone immediately';
  assert (select cancel_requested_at is not null from public.jobs where generation_id = v_gen),
    'the worker is asked to stop';
  assert (select state from public.jobs where generation_id = v_gen) = 'submitted',
    'only the lease holder may settle a job';
  assert (select count(*) from public.deletion_outbox
           where reason = 'generation_deleted' and object_path like v_user::text || '%') = 0,
    'nothing may be queued while the job can still produce it';

  -- Asking again while the job runs is the same request, not an error.
  v_out := public.fn_delete_generation(v_user, v_gen);
  assert v_out->>'status' = 'pending_job', format('repeat said %s', v_out);

  -- The job settles; the reaper may now finish the job it started.
  update public.jobs set state = 'done' where generation_id = v_gen;
  perform public.fn_reap_deleted(v_user);

  assert not exists (select 1 from public.generations where id = v_gen);
  assert (select count(*) from public.deletion_outbox
           where object_path = v_user::text || '/' || v_gen::text || '.png') = 1;
end $$;

-- 6. Deleting twice is idempotent, and the second attempt does not postpone
--    the first one's cleanup.
do $$
declare
  v_user uuid := 'eeee0000-0000-4000-8000-000000000006';
  v_gen uuid := 'eeee1111-0000-4000-8000-000000000006';
  v_path text; v_first timestamptz; v_object uuid; v_raised text := '';
begin
  perform pg_temp.seed_user(v_user, 'del6@example.com');
  perform pg_temp.seed_image(v_user, v_gen);
  v_path := v_user::text || '/' || v_gen::text || '.png';

  perform public.fn_delete_generation(v_user, v_gen);
  select not_before, object_id into v_first, v_object from public.deletion_outbox
   where object_path = v_path;

  -- The row itself is gone now, so the second attempt has nothing to find.
  -- (A row still held back by a running job answers again instead — block 5.)
  begin
    perform public.fn_delete_generation(v_user, v_gen);
  exception when others then v_raised := sqlerrm;
  end;
  assert v_raised = 'not_found', format('second delete said %s', v_raised);

  -- A re-enqueue an hour out must not push the authorised deletion later.
  perform public.fn_enqueue_deletions(to_jsonb(array[v_object]), 'again', now() + interval '1 hour');
  assert (select not_before from public.deletion_outbox where object_path = v_path) = v_first,
    'a later request must never delay an earlier authorised deletion';
  assert (select count(*) from public.deletion_outbox where object_path = v_path) = 1;
end $$;

-- 7. Two workers cannot claim the same row, and a stale token cannot
--    acknowledge another worker's deletion.
do $$
declare
  v_user uuid := 'eeee0000-0000-4000-8000-000000000007';
  v_gen uuid := 'eeee1111-0000-4000-8000-000000000007';
  v_id uuid; v_token uuid; v_second int; v_ack jsonb;
begin
  perform pg_temp.seed_user(v_user, 'del7@example.com');
  perform pg_temp.seed_image(v_user, v_gen);
  perform public.fn_delete_generation(v_user, v_gen);

  select id, lease_token into v_id, v_token from public.fn_claim_deletions(10);
  select count(*) into v_second from public.fn_claim_deletions(10);
  assert v_second = 0, 'a leased row must not be claimable again';

  v_ack := public.fn_complete_deletion(v_id, gen_random_uuid(), null);
  assert (v_ack->>'acknowledged')::boolean = false, 'a stale token cannot complete a deletion';
  assert (select completed_at is null from public.deletion_outbox where id = v_id);

  v_ack := public.fn_complete_deletion(v_id, v_token, null);
  assert (v_ack->>'acknowledged')::boolean = true;
  assert (select completed_at is not null from public.deletion_outbox where id = v_id);
  assert (select state from public.storage_objects where id =
          (select object_id from public.deletion_outbox where id = v_id)) = 'gone';
end $$;

-- 8. A failed deletion keeps the row, backs off, and is dead-lettered — never
--    dropped — once the D2 budget is spent.
do $$
declare
  v_user uuid := 'eeee0000-0000-4000-8000-000000000008';
  v_gen uuid := 'eeee1111-0000-4000-8000-000000000008';
  v_id uuid; v_token uuid; v_ack jsonb; v_state text;
begin
  perform pg_temp.seed_user(v_user, 'del8@example.com');
  perform pg_temp.seed_image(v_user, v_gen);
  perform public.fn_delete_generation(v_user, v_gen);

  select id, lease_token into v_id, v_token from public.fn_claim_deletions(10);
  v_ack := public.fn_complete_deletion(v_id, v_token, 'storage 500');
  assert v_ack->>'state' = 'retry', format('got %s', v_ack);
  assert (select not_before > now() from public.deletion_outbox where id = v_id),
    'a failure must back off, not spin';
  assert (select last_error from public.deletion_outbox where id = v_id) = 'storage 500';
  assert (select state from public.storage_objects where id =
          (select object_id from public.deletion_outbox where id = v_id)) = 'delete_pending',
    'a failed delete is not a removal';

  -- Spend the budget.
  update public.deletion_outbox set attempts = 12, not_before = now(), lease_token = null
   where id = v_id;
  select id, lease_token into v_id, v_token from public.fn_claim_deletions(10);
  v_ack := public.fn_complete_deletion(v_id, v_token, 'storage 500');
  assert v_ack->>'state' = 'dead_letter', format('got %s', v_ack);
  assert (select count(*) from public.deletion_outbox where id = v_id) = 1,
    'a dead letter is kept and alerted on, never discarded';
end $$;

-- 9. Held evidence is not deletable, and is not silently treated as gone.
do $$
declare
  v_user uuid := 'eeee0000-0000-4000-8000-000000000009';
  v_object uuid;
begin
  perform pg_temp.seed_user(v_user, 'del9@example.com');
  v_object := public.fn_register_object(
    v_user, 'supabase', 'uploads', 'quarantine/' || v_user::text || '/x.png', 'quarantine');
  perform public.fn_hold_object(v_object, now() + interval '12 months');

  perform public.fn_enqueue_deletions(to_jsonb(array[v_object]), 'account_deleted');

  assert (select state from public.storage_objects where id = v_object) = 'held',
    'an enqueue must not drag held evidence out of its hold';
  assert (select count(*) from public.deletion_outbox where object_id = v_object) = 0,
    'evidence under hold must never be queued for deletion';

  -- Once the deadline passes it becomes ordinary content again.
  update public.storage_objects set retain_until = now() - interval '1 day' where id = v_object;
  perform public.fn_enqueue_deletions(to_jsonb(array[v_object]), 'retention_expired');
  assert (select count(*) from public.deletion_outbox where object_id = v_object) = 1;
end $$;

-- 10. Account closure: content hidden at once, money history kept and
--     anonymised, evidence held, auth removal left to the worker.
do $$
declare
  v_user uuid := 'eeee0000-0000-4000-8000-000000000010';
  v_gen uuid := 'eeee1111-0000-4000-8000-000000000010';
  v_video uuid := 'eeee1111-0000-4000-8000-000000000011';
  v_persona uuid := 'eeee2222-0000-4000-8000-000000000010';
  v_request uuid; v_out jsonb; v_event uuid;
begin
  perform pg_temp.seed_user(v_user, 'del10@example.com');
  perform pg_temp.seed_image(v_user, v_gen);
  perform pg_temp.seed_video(v_user, v_video);
  perform pg_temp.seed_persona(v_user, v_persona, 'https://fal.example/lora/ten.safetensors');
  insert into public.billing_transactions
    (user_id, source, business_txn_id, kind, credits, event_at, result)
  values (v_user, 'stripe', 'pi_test_10', 'pack_grant', 500, now(), '{}'::jsonb);
  insert into public.moderation_events (user_id, source, prompt, quarantine_path)
  values (v_user, 'upload', null, 'quarantine/' || v_user::text || '/evidence.png')
  returning id into v_event;
  perform public.fn_register_object(
    v_user, 'supabase', 'uploads', 'quarantine/' || v_user::text || '/evidence.png', 'quarantine');

  v_out := public.fn_delete_account(v_user);
  v_request := (v_out->>'requestId')::uuid;

  -- Nothing is running, so there is nothing to wait for: the data goes in
  -- this call. A provider we have not heard back from must not keep the
  -- customer's own files alive — it blocks completion, not finalisation.
  assert v_out->>'status' = 'processing', format('got %s', v_out);
  assert (v_out->>'providerArtifacts')::int = 1,
    'a provider-hosted LoRA is unresolved work, not a completed deletion';
  assert not exists (select 1 from public.generations where user_id = v_user),
    'content is removed immediately — there is no undo window (D2)';

  assert v_out->>'status' = 'processing', 'not complete until the auth user is gone';
  assert v_out->>'authUserId' = v_user::text, 'the worker is told which auth user to remove';
  assert not exists (select 1 from public.profiles where id = v_user), 'the profile is gone';
  assert (select user_id is null and deletion_ref = v_request
            from public.billing_transactions where business_txn_id = 'pi_test_10'),
    'financial history survives, anonymised (D2)';
  assert (select count(*) from public.ledger_entries where deletion_ref = v_request) > 0,
    'the ledger is anonymised, not deleted';
  assert (select user_id is null and deletion_ref = v_request
            from public.moderation_events where id = v_event),
    'moderation evidence survives for appeals, anonymised';
  assert (select state = 'held' and retain_until > now() + interval '300 days'
            from public.storage_objects
           where path = 'quarantine/' || v_user::text || '/evidence.png'),
    'evidence objects are held for 12 months, not queued for deletion';
  assert (select count(*) from public.deletion_outbox d
            join public.storage_objects o on o.id = d.object_id
           where d.completed_at is null and o.purpose in ('media','thumb')) > 0,
    'the locators outlive the profile — that is what makes cleanup possible';

  assert (select deletion_ref = v_request and user_id is null
            from public.provider_artifact_deletions
           where artifact_ref = 'https://fal.example/lora/ten.safetensors'),
    'the unresolved artifact stays attached to the closure that must report it';

  -- The auth user is gone, but fal has not answered: still not "completed".
  v_out := public.fn_complete_account_deletion(v_request);
  assert v_out->>'status' = 'processing', format('got %s', v_out);
  assert v_out->>'reason' = 'provider_artifacts_unresolved',
    'a closure with a live third-party copy is not a finished deletion';
  assert (v_out->>'providerArtifacts')::int = 1;

  -- fal confirms the LoRA is gone. Only now is the closure done.
  update public.provider_artifact_deletions set status = 'confirmed', evidence_ref = 'fal-ack-1'
   where deletion_ref = v_request;

  v_out := public.fn_complete_account_deletion(v_request);
  assert v_out->>'status' = 'completed', format('got %s', v_out);
  assert (select auth_user_id is null and user_id is null
            from public.account_deletions where id = v_request),
    'the audit row is anonymised once the closure is done';
end $$;

-- 11. A closure with work still running does not finalise, and asking again
--     is safe.
do $$
declare
  v_user uuid := 'eeee0000-0000-4000-8000-000000000012';
  v_gen uuid := 'eeee1111-0000-4000-8000-000000000012';
  v_first jsonb; v_second jsonb;
begin
  perform pg_temp.seed_user(v_user, 'del12@example.com');
  perform pg_temp.seed_image(v_user, v_gen);
  update public.generations set status = 'pending' where id = v_gen;
  insert into public.jobs (user_id, generation_id, provider, state)
  values (v_user, v_gen, 'fal', 'submitted');

  v_first := public.fn_delete_account(v_user);
  v_second := public.fn_delete_account(v_user);

  assert v_first->>'requestId' = v_second->>'requestId', 'closure must be idempotent';
  assert (v_first->>'pendingJobs')::int = 1;
  assert (select deletion_requested_at is not null from public.profiles where id = v_user);

  -- New work is refused while a closure is draining.
  declare v_raised text := '';
  begin
    begin
      insert into public.generations
        (user_id, kind, family_id, family_name, op, prompt, settings, price_credits, status, media_url)
      values (v_user, 'image', 'flux', 'FLUX', 'generate', 'x', '{}'::jsonb, 40, 'pending', '');
    exception when others then v_raised := sqlerrm;
    end;
    assert v_raised = 'account_closing', format('closed account accepted new work: %s', v_raised);
  end;

  assert (select count(*) from public.profiles where id = v_user) = 1,
    'a profile must not be removed while a job can still write to it';
  assert (select count(*) from public.account_deletions where user_id = v_user) = 1;
end $$;

-- 12. The lapse purge obeys D2: the paid period is the grace, and it queues
--     bytes instead of stranding them.
do $$
declare
  v_user uuid := 'eeee0000-0000-4000-8000-000000000013';
  v_gen uuid := 'eeee1111-0000-4000-8000-000000000013';
  v_still uuid := 'eeee0000-0000-4000-8000-000000000014';
  v_kept uuid := 'eeee1111-0000-4000-8000-000000000014';
begin
  perform pg_temp.seed_user(v_user, 'lapse13@example.com');
  perform pg_temp.seed_image(v_user, v_gen);
  update public.subscriptions
     set status = 'canceled', current_period_end = now() - interval '1 hour'
   where user_id = v_user;

  -- A subscriber whose paid period has NOT ended keeps everything.
  perform pg_temp.seed_user(v_still, 'lapse14@example.com');
  perform pg_temp.seed_image(v_still, v_kept);
  update public.subscriptions
     set status = 'canceled', current_period_end = now() + interval '2 days'
   where user_id = v_still;

  perform public.fn_purge_lapsed();

  assert not exists (select 1 from public.generations where id = v_gen),
    'the library goes when the paid period ends (D2)';
  assert (select count(*) from public.deletion_outbox
           where object_path = v_user::text || '/' || v_gen::text || '.png') = 1,
    'the purge queues the bytes; the old cron left them forever';
  assert exists (select 1 from public.generations where id = v_kept),
    'a paid-up period is not a lapse';
end $$;

-- 13. A registry failure takes the row deletion with it. Losing the locator
--     while dropping the row is the original defect.
create or replace function pg_temp.break_outbox() returns trigger language plpgsql as $fn$
begin
  raise exception 'outbox unavailable';
end $fn$;

do $$
declare
  v_user uuid := 'eeee0000-0000-4000-8000-000000000015';
  v_gen uuid := 'eeee1111-0000-4000-8000-000000000015';
  v_raised text := '';
begin
  perform pg_temp.seed_user(v_user, 'del15@example.com');
  perform pg_temp.seed_image(v_user, v_gen);

  create trigger break_outbox before insert on public.deletion_outbox
    for each row execute function pg_temp.break_outbox();

  begin
    perform public.fn_delete_generation(v_user, v_gen);
  exception when others then v_raised := sqlerrm;
  end;
  drop trigger break_outbox on public.deletion_outbox;

  assert v_raised = 'outbox unavailable', format('got %s', v_raised);
  assert exists (select 1 from public.generations where id = v_gen),
    'the row must survive when its locator could not be recorded';
end $$;

rollback;
