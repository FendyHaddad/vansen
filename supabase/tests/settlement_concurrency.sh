#!/usr/bin/env bash
# A success and a cancel racing on the same job. LOCAL DATABASE ONLY.
#
# The point is the pair: a generation must never end up `done` AND refunded.
# Run it several times — a race proof that passes once is not a proof.
set -euo pipefail
# Optional argument: seconds to hold the cancel back. With no delay the cancel
# consistently wins on this machine, which only ever exercises one branch — run
# it once with e.g. 0.3 to make the success win and prove the other one.
DELAY="${1:-0}"
DB="${VANSEN_LOCAL_DB:?set VANSEN_LOCAL_DB first}"
U='aaaaaaaa-0000-4000-8000-000000000003'

# Setup and the id query are separate calls on purpose: a multi-statement -c
# also prints "INSERT 0 1" lines, which `read` would happily take as the ids.
psql "$DB" -q -v ON_ERROR_STOP=1 -c "
  insert into auth.users (id, email) values ('$U','race2@example.com') on conflict do nothing;
  insert into public.profiles (id, birth_date) values ('$U','1990-01-01') on conflict do nothing;
" >/dev/null

read -r GEN JOB <<< "$(psql "$DB" -t -A -F' ' -v ON_ERROR_STOP=1 -c "
  with g as (
    insert into public.generations
      (user_id,kind,family_id,family_name,op,prompt,settings,price_credits,charged_plan,charged_pack,status,media_url)
    values ('$U','image','flux','FLUX','generate','p','{}'::jsonb,40,40,0,'pending','')
    returning id
  ), j as (
    insert into public.jobs (generation_id,user_id,provider) select id,'$U','fal' from g returning id, generation_id
  )
  select j.generation_id, j.id from j;
")"

test -n "$GEN" && test -n "$JOB" || { echo "FAIL: setup did not return ids (GEN='$GEN' JOB='$JOB')"; exit 1; }

psql "$DB" -q -c "select public.fn_settle_job('$JOB','done','u/g.png','supabase','{}'::jsonb,null);" >/dev/null &
(sleep "$DELAY"; psql "$DB" -q -c "select public.fn_settle_job('$JOB','failed',null,null,'{}'::jsonb,'cancelled');" >/dev/null) &
wait

STATUS=$(psql "$DB" -t -A -c "select status from public.generations where id='$GEN';")
REFUNDS=$(psql "$DB" -t -A -c "select coalesce(sum(amount_credits),0) from public.ledger_entries where user_id='$U' and type='refund';")
NOTES=$(psql "$DB" -t -A -c "select count(*) from public.notification_outbox where generation_id='$GEN';")

psql "$DB" -q -c "
  delete from public.notification_outbox where user_id='$U';
  delete from public.ledger_entries where user_id='$U';
  delete from public.jobs where user_id='$U';
  delete from public.generations where user_id='$U';
  delete from public.profiles where id='$U';
  delete from auth.users where id='$U';
"

if [ "$STATUS" = "done" ]; then
  test "$NOTES" = "1" || { echo "FAIL: a done generation must queue exactly 1 notification, got $NOTES"; exit 1; }
  test "$REFUNDS" = "0" || { echo "FAIL: done generation was also refunded $REFUNDS"; exit 1; }
else
  # A cancel refunds but deliberately queues no failure notification.
  test "$NOTES" = "0" || { echo "FAIL: a cancel must not notify, got $NOTES"; exit 1; }
  test "$REFUNDS" = "40" || { echo "FAIL: failed generation refunded $REFUNDS, expected 40"; exit 1; }
fi
echo "OK: single terminal transition ($STATUS, refunded $REFUNDS, notifications $NOTES)"
