#!/usr/bin/env bash
# Caps under real concurrency. LOCAL DATABASE ONLY.
#
# A cap checked with a separate select before the charge is not a cap, it is a
# suggestion: four simultaneous submissions all saw two pending videos and all
# passed a three-video limit. These run in separate psql sessions, so the
# advisory locks in fn_reserve_generation are the only thing standing between
# them.
set -euo pipefail
DB="${VANSEN_LOCAL_DB:?set VANSEN_LOCAL_DB first}"
U='eeeeeeee-0000-4000-8000-000000000001'
P='eeeeeeee-0000-4000-8000-000000000002'
FAILED=0

cleanup() {
  psql "$DB" -q -c "
    delete from public.training_provider_expenses where user_id in ('$U','$P');
    delete from public.training_jobs where user_id in ('$U','$P');
    delete from public.provider_expenses where user_id in ('$U','$P');
    delete from public.notification_outbox where user_id in ('$U','$P');
    delete from public.submissions where user_id in ('$U','$P');
    delete from public.jobs where user_id in ('$U','$P');
    delete from public.generations where user_id in ('$U','$P');
    delete from public.personas where user_id in ('$U','$P');
    delete from public.ledger_entries where user_id in ('$U','$P');
    delete from public.subscriptions where user_id in ('$U','$P');
    delete from public.profiles where id in ('$U','$P');
    delete from auth.users where id in ('$U','$P');
  " >/dev/null
}

seed() {
  local id="$1" email="$2" plan="$3" credits="$4"
  psql "$DB" -q -v ON_ERROR_STOP=1 -c "
    insert into auth.users (id, email) values ('$id','$email') on conflict do nothing;
    insert into public.profiles (id, birth_date) values ('$id','1990-01-01') on conflict do nothing;
    insert into public.subscriptions (user_id, plan, status, current_period_end)
      values ('$id','$plan','active', now() + interval '30 days')
      on conflict (user_id) do update set plan = excluded.plan, status = 'active';
    insert into public.ledger_entries (user_id, type, bucket, amount_credits, note)
      values ('$id','cycle_reset','plan',$credits,'caps concurrency seed');
  " >/dev/null
}

items() {
  local kind="$1" credits="$2"
  echo "jsonb_build_array(jsonb_build_object(
    'kind','$kind','familyId','kling','familyName','Kling','op','generate',
    'prompt','p','settings','{}'::jsonb,'priceCredits',$credits))"
}

quote() {
  echo "jsonb_build_object('provider','fal','chargeType','generate','unitCredits',$1,
    'unitProviderCostUsd',$2,'catalogVersion','2026-09-20.2','quoteVersion',1)"
}

check() {
  local label="$1" expected="$2" actual="$3"
  test "$actual" = "$expected" || {
    echo "FAIL: $label — expected $expected, got $actual"
    FAILED=1
  }
}

trap cleanup EXIT

# ---------------------------------------------------------------- video slots
cleanup
seed "$U" 'caps@example.com' 'pro' 100000
for i in 1 2 3 4; do
  psql "$DB" -q -c "select public.fn_reserve_generation(
    '$U', gen_random_uuid(), 'h$i', $(items video 100), $(quote 100 0.5), '{}'::jsonb);" \
    >/dev/null 2>&1 &
done
wait

PENDING=$(psql "$DB" -t -A -c "
  select count(*) from public.generations where user_id = '$U' and kind = 'video';")
check "four simultaneous video submissions against a limit of 3" "3" "$PENDING"
ORPHANS=$(psql "$DB" -t -A -c "
  select count(*) from public.generations g left join public.jobs j on j.generation_id = g.id
  where g.user_id = '$U' and j.id is null;")
check "no generation without a job" "0" "$ORPHANS"
CHARGED=$(psql "$DB" -t -A -c "
  select coalesce(-sum(amount_credits),0) from public.ledger_entries
  where user_id = '$U' and type = 'generate';")
check "exactly three charges" "300" "$CHARGED"

# ------------------------------------------------------------------ same key
cleanup
seed "$U" 'caps@example.com' 'pro' 100000
KEY=$(psql "$DB" -t -A -c "select gen_random_uuid();")
for i in 1 2; do
  psql "$DB" -q -c "select public.fn_reserve_generation(
    '$U', '$KEY', 'same-body', $(items image 40), $(quote 40 0.012), '{}'::jsonb);" \
    >/dev/null 2>&1 &
done
wait

GENS=$(psql "$DB" -t -A -c "select count(*) from public.generations where user_id = '$U';")
check "two concurrent calls with one key create one generation" "1" "$GENS"
SUBS=$(psql "$DB" -t -A -c "select count(*) from public.submissions where user_id = '$U';")
check "one submission record" "1" "$SUBS"
SPENT=$(psql "$DB" -t -A -c "
  select coalesce(-sum(amount_credits),0) from public.ledger_entries
  where user_id = '$U' and type = 'generate';")
check "charged once" "40" "$SPENT"

# ------------------------------------------------------------- persona slots
cleanup
seed "$P" 'caps-persona@example.com' 'studio' 100000
psql "$DB" -q -c "
  insert into public.personas (user_id, name) values ('$P','Existing 1'),('$P','Existing 2');" >/dev/null
for i in 1 2; do
  psql "$DB" -q -c "select public.fn_reserve_persona(
    '$P', gen_random_uuid(), 'hp$i', 'Racer $i');" >/dev/null 2>&1 &
done
wait
PERSONAS=$(psql "$DB" -t -A -c "select count(*) from public.personas where user_id = '$P';")
check "two concurrent creations at a full slot limit create none" "2" "$PERSONAS"

cleanup
seed "$P" 'caps-persona@example.com' 'studio' 100000
psql "$DB" -q -c "insert into public.personas (user_id, name) values ('$P','Existing 1');" >/dev/null
for i in 1 2; do
  psql "$DB" -q -c "select public.fn_reserve_persona(
    '$P', gen_random_uuid(), 'hq$i', 'Racer $i');" >/dev/null 2>&1 &
done
wait
PERSONAS=$(psql "$DB" -t -A -c "select count(*) from public.personas where user_id = '$P';")
check "two concurrent creations for one remaining slot accept exactly one" "2" "$PERSONAS"

test "$FAILED" = "0" || exit 1
echo "OK: caps hold under concurrency (video slots, idempotency key, persona slots)"
