-- Persona as saved references: five named slots, consent recorded, slots
-- counted under a lock, replaced photos deleted, and no provider artifact.
-- LOCAL DATABASE ONLY. See supabase/tests/upload_ownership.sql for the recipe.
begin;

create or replace function pg_temp.seed_user(p_user uuid, p_plan text)
returns void language plpgsql as $$
begin
  insert into auth.users (id, email) values (p_user, p_user::text || '@example.com') on conflict do nothing;
  insert into public.profiles (id, birth_date) values (p_user, '1990-01-01') on conflict do nothing;
  insert into public.subscriptions (user_id, plan, status, current_period_end)
  values (p_user, p_plan, 'active', now() + interval '30 days')
  on conflict (user_id) do update set plan = p_plan, status = 'active';
end $$;

create or replace function pg_temp.seed_upload_as(
  p_user uuid, p_n int, p_purpose text, p_moderation text)
returns text language plpgsql as $$
declare v_path text := p_user::text || '/' || lpad(p_n::text, 8, '0') || '-0000-4000-8000-000000000000.jpg';
begin
  insert into public.uploads (user_id, path, purpose, mime, bytes, width, height, moderation)
  values (p_user, v_path, p_purpose, 'image/jpeg', 1000, 1536, 2048, p_moderation);
  perform public.fn_register_object(p_user, 'supabase', 'uploads', v_path,
    case when p_purpose = 'persona-photo' then 'persona-photo' else 'upload' end);
  update public.storage_objects set state = 'live' where path = v_path;
  return v_path;
end $$;

create or replace function pg_temp.seed_upload(p_user uuid, p_n int)
returns text language sql as $$
  select pg_temp.seed_upload_as(p_user, p_n, 'persona-photo', 'allowed');
$$;

/** The error a photo placement raised, or '' when it was accepted. */
create or replace function pg_temp.place_error(p_user uuid, p_persona uuid, p_slot text, p_path text)
returns text language plpgsql as $$
begin
  perform public.fn_set_persona_photo(p_user, p_persona, p_slot, p_path);
  return '';
exception when others then
  return sqlerrm;
end $$;

-- 1. A new persona is a draft with consent recorded and five empty slots.
do $$
declare v_user uuid := 'aaaa3333-0000-4000-8000-000000000001'; v_id uuid;
begin
  perform pg_temp.seed_user(v_user, 'studio');
  v_id := (public.fn_reserve_persona(v_user, gen_random_uuid(), 'h1', 'Me')->>'personaId')::uuid;
  assert (select status from public.personas where id = v_id) = 'draft';
  assert (select consent_attested_at from public.personas where id = v_id) is not null;
  assert (select photos from public.personas where id = v_id) = jsonb_build_object(
    'front', null, 'left_three_quarter', null, 'right_three_quarter', null,
    'left_profile', null, 'right_profile', null);
end $$;

-- 2. Only the five slot keys are accepted.
do $$
declare v_user uuid := 'aaaa3333-0000-4000-8000-000000000001'; v_id uuid; v_failed boolean := false;
begin
  select id into v_id from public.personas where user_id = v_user limit 1;
  begin
    update public.personas set photos = photos || '{"back": null}'::jsonb where id = v_id;
  exception when check_violation then v_failed := true;
  end;
  assert v_failed, 'an unknown slot key must be rejected';

  v_failed := false;
  begin
    update public.personas set status = 'ready' where id = v_id;
  exception when check_violation then v_failed := true;
  end;
  assert v_failed, 'a persona with an empty slot cannot be marked ready';
end $$;

-- 3. Filling all five slots makes it ready; replacing one queues the old photo.
do $$
declare
  v_user uuid := 'aaaa3333-0000-4000-8000-000000000001'; v_id uuid; v_old text; v_new text;
  v_slot text; v_i int := 0; v_out jsonb;
begin
  select id into v_id from public.personas where user_id = v_user limit 1;
  foreach v_slot in array array['front','left_three_quarter','right_three_quarter','left_profile','right_profile'] loop
    v_i := v_i + 1;
    v_out := public.fn_set_persona_photo(v_user, v_id, v_slot, pg_temp.seed_upload(v_user, v_i));
  end loop;
  assert v_out->>'status' = 'ready';
  assert (select status from public.personas where id = v_id) = 'ready';
  begin
    update public.personas set status = 'draft' where id = v_id;
    assert false, 'a persona with every slot filled cannot be a draft';
  exception when check_violation then null;
  end;

  v_old := (select photos->>'front' from public.personas where id = v_id);
  v_new := pg_temp.seed_upload(v_user, 99);
  v_out := public.fn_set_persona_photo(v_user, v_id, 'front', v_new);
  assert (v_out->>'replaced')::boolean;
  assert (select photos->>'front' from public.personas where id = v_id) = v_new;
  assert exists (
    select 1 from public.deletion_outbox d join public.storage_objects o on o.id = d.object_id
     where o.path = v_old and d.reason = 'persona_photo_replaced' and d.completed_at is null),
    'the replaced photo must be queued for deletion';
end $$;

-- 4. A photo that is not the caller's allowed persona-photo upload is refused.
do $$
declare
  v_user uuid := 'aaaa3333-0000-4000-8000-000000000001';
  v_other uuid := 'aaaa3333-0000-4000-8000-000000000004';
  v_id uuid; v_path text; v_err text;
begin
  select id into v_id from public.personas where user_id = v_user limit 1;
  v_err := pg_temp.place_error(v_user, v_id, 'front', 'someone-else/x.jpg');
  assert v_err = 'invalid_photo', format('an unknown path: got "%s"', v_err);

  perform pg_temp.seed_user(v_other, 'studio');
  v_path := pg_temp.seed_upload(v_other, 1);
  v_err := pg_temp.place_error(v_user, v_id, 'front', v_path);
  assert v_err = 'invalid_photo', format('another user''s upload: got "%s"', v_err);

  v_path := pg_temp.seed_upload_as(v_user, 41, 'persona-photo', 'pending');
  v_err := pg_temp.place_error(v_user, v_id, 'front', v_path);
  assert v_err = 'invalid_photo', format('an unmoderated upload: got "%s"', v_err);

  v_path := pg_temp.seed_upload_as(v_user, 42, 'persona-photo', 'blocked');
  v_err := pg_temp.place_error(v_user, v_id, 'front', v_path);
  assert v_err = 'invalid_photo', format('a blocked upload: got "%s"', v_err);

  v_path := pg_temp.seed_upload_as(v_user, 43, 'reference', 'allowed');
  v_err := pg_temp.place_error(v_user, v_id, 'front', v_path);
  assert v_err = 'invalid_photo', format('a reference upload: got "%s"', v_err);
end $$;

-- 5. Slots are counted for draft and ready only; the plan limit holds.
do $$
declare v_user uuid := 'aaaa3333-0000-4000-8000-000000000001'; v_failed boolean := false;
begin
  -- A tombstoned persona waiting for its reap holds no slot: with it counted,
  -- the next reservation would already be over the limit.
  insert into public.personas (user_id, name, consent_attested_at, deleted_at)
  values (v_user, 'Tombstoned', now(), now());
  perform public.fn_reserve_persona(v_user, gen_random_uuid(), 'h2', 'Second');
  begin
    perform public.fn_reserve_persona(v_user, gen_random_uuid(), 'h3', 'Third');
  exception when others then v_failed := sqlerrm like '%slot_limit%';
  end;
  assert v_failed, 'studio allows two personas';
end $$;

-- 6. Deleting a persona queues its photos and records no provider artifact.
do $$
declare v_user uuid := 'aaaa3333-0000-4000-8000-000000000001'; v_id uuid;
begin
  select id into v_id from public.personas where user_id = v_user and status = 'ready';
  perform public.fn_delete_persona(v_user, v_id);
  assert not exists (select 1 from public.personas where id = v_id);
  assert (select count(*) from public.deletion_outbox
           where reason = 'persona_deleted' and completed_at is null
             and object_path like v_user::text || '/%') = 5;
  assert not exists (select 1 from public.provider_artifact_deletions where user_id = v_user);
end $$;

-- 7. The training pipeline is gone.
do $$
begin
  assert to_regclass('public.training_jobs') is null;
  assert not exists (select 1 from pg_proc where proname in
    ('fn_reserve_training','fn_settle_training','fn_claim_training_jobs','fn_release_training_job',
     'fn_begin_training_submit','fn_record_training_ref','fn_charge_persona','fn_fail_persona'));
  assert not exists (select 1 from cron.job where jobname = 'reconcile_stale_trainings');
  assert to_regclass('public.training_provider_expenses') is not null, 'money records stay';
end $$;

-- 8. Nothing left in the schema still reads the dropped table or columns, and
--    the scheduled functions that used to touch training still run.
do $$
begin
  assert not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prosrc ~ '\m(training_jobs|photo_paths|lora_url|trigger_word|training_started_at|trained_at)\M'),
    'a function still references the retired training pipeline';
  perform public.fn_expire_leases();
  perform public.fn_check_alerts();
  perform public.backoffice_feature_usage(30);
end $$;

-- 9. A photo still held by another slot is not deleted when one slot moves on.
do $$
declare v_user uuid := 'aaaa3333-0000-4000-8000-000000000002'; v_id uuid; v_shared text; v_out jsonb;
begin
  perform pg_temp.seed_user(v_user, 'studio');
  v_id := (public.fn_reserve_persona(v_user, gen_random_uuid(), 'h9', 'Twin')->>'personaId')::uuid;
  v_shared := pg_temp.seed_upload(v_user, 1);
  perform public.fn_set_persona_photo(v_user, v_id, 'front', v_shared);
  perform public.fn_set_persona_photo(v_user, v_id, 'left_profile', v_shared);
  v_out := public.fn_set_persona_photo(v_user, v_id, 'front', pg_temp.seed_upload(v_user, 2));
  assert (v_out->>'replaced')::boolean;
  assert not exists (
    select 1 from public.deletion_outbox where object_path = v_shared and completed_at is null),
    'a photo another slot still uses must not be queued';

  v_out := public.fn_set_persona_photo(v_user, v_id, 'left_profile', pg_temp.seed_upload(v_user, 3));
  assert (v_out->>'replaced')::boolean;
  assert exists (
    select 1 from public.deletion_outbox
     where object_path = v_shared and reason = 'persona_photo_replaced' and completed_at is null),
    'once the last slot lets go of a photo, it is queued';
end $$;

-- 10. A photo whose bytes are going, or that another persona holds, is refused.
do $$
declare
  v_user uuid := 'aaaa3333-0000-4000-8000-000000000003';
  v_p1 uuid; v_p2 uuid; v_x text; v_z text; v_err text;
begin
  perform pg_temp.seed_user(v_user, 'studio');
  v_p1 := (public.fn_reserve_persona(v_user, gen_random_uuid(), 'h10a', 'One')->>'personaId')::uuid;
  v_p2 := (public.fn_reserve_persona(v_user, gen_random_uuid(), 'h10b', 'Two')->>'personaId')::uuid;

  -- A. X is replaced, so it is queued; putting it back in another slot would
  --    point the persona at bytes the cleanup worker is about to remove.
  v_x := pg_temp.seed_upload(v_user, 1);
  perform public.fn_set_persona_photo(v_user, v_p1, 'front', v_x);
  perform public.fn_set_persona_photo(v_user, v_p1, 'front', pg_temp.seed_upload(v_user, 2));
  v_err := pg_temp.place_error(v_user, v_p1, 'left_profile', v_x);
  assert v_err = 'invalid_photo', format('a queued photo: got "%s"', v_err);
  assert (select photos->>'left_profile' from public.personas where id = v_p1) is null;

  -- An upload with no registry row at all is refused as well.
  insert into public.uploads (user_id, path, purpose, mime, bytes, width, height, moderation)
  values (v_user, v_user::text || '/unregistered.jpg', 'persona-photo', 'image/jpeg',
          1000, 1536, 2048, 'allowed');
  v_err := pg_temp.place_error(v_user, v_p1, 'left_profile', v_user::text || '/unregistered.jpg');
  assert v_err = 'invalid_photo', format('an unregistered photo: got "%s"', v_err);

  -- B. Z belongs to P1; P2 may not share it, or deleting P1 would take it.
  v_z := pg_temp.seed_upload(v_user, 3);
  perform public.fn_set_persona_photo(v_user, v_p1, 'right_profile', v_z);
  v_err := pg_temp.place_error(v_user, v_p2, 'front', v_z);
  assert v_err = 'invalid_photo', format('another persona''s photo: got "%s"', v_err);
  assert (select photos->>'front' from public.personas where id = v_p2) is null;

  perform public.fn_delete_persona(v_user, v_p1);
  assert not exists (
    select 1 from public.personas p, jsonb_each_text(p.photos) e
     where p.id = v_p2 and e.value = v_z),
    'the surviving persona does not point at the deleted one''s photo';
end $$;

-- 11. The plan is read the way the gateway's activePlan reads it: a canceled
--     subscription (Stripe sets it on cancel-at-period-end) still reserves
--     until its paid period ends, and not after.
do $$
declare v_user uuid := 'aaaa3333-0000-4000-8000-000000000005'; v_err text := '';
begin
  perform pg_temp.seed_user(v_user, 'studio');
  update public.subscriptions set status = 'canceled', current_period_end = now() + interval '5 days'
   where user_id = v_user;
  assert (public.fn_reserve_persona(v_user, gen_random_uuid(), 'h11a', 'Paid through')->>'personaId') is not null,
    'a canceled plan inside its paid period can reserve';

  update public.subscriptions set current_period_end = now() - interval '1 day' where user_id = v_user;
  begin
    perform public.fn_reserve_persona(v_user, gen_random_uuid(), 'h11b', 'Lapsed');
  exception when others then v_err := sqlerrm;
  end;
  assert v_err = 'subscription_required', format('a lapsed canceled plan: got "%s"', v_err);

  v_err := '';
  update public.subscriptions set status = 'expired', current_period_end = now() + interval '5 days'
   where user_id = v_user;
  begin
    perform public.fn_reserve_persona(v_user, gen_random_uuid(), 'h11c', 'Expired');
  exception when others then v_err := sqlerrm;
  end;
  assert v_err = 'subscription_required', format('an expired plan: got "%s"', v_err);
end $$;

-- 12. The persona kill switch ships off, until the live smoke passes.
do $$
begin
  assert (select enabled from public.models where id = 'persona') = false,
    'persona must ship disabled';
end $$;

rollback;
