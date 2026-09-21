#!/usr/bin/env bash
# Two simultaneous deliveries of the SAME invoice must grant once.
# LOCAL DATABASE ONLY.
set -euo pipefail
DB="${VANSEN_LOCAL_DB:?set VANSEN_LOCAL_DB first}"
USER_ID='99999999-9999-4999-8999-999999999999'

psql "$DB" -v ON_ERROR_STOP=1 -q -c "
  insert into auth.users (id, email) values ('$USER_ID','race@example.com') on conflict do nothing;
  insert into public.profiles (id, birth_date) values ('$USER_ID','1990-01-01') on conflict do nothing;
  delete from public.ledger_entries where user_id = '$USER_ID';
  delete from public.billing_transactions where user_id = '$USER_ID';
"

# Both callers must RETURN CLEANLY. Without the advisory lock the loser races
# into the unique index and gets a duplicate-key ERROR instead of a replay
# result — the constraint would still grant once, but the webhook would 500 and
# Stripe would retry forever. The lock is what turns that into a clean replay.
CALL="select public.fn_apply_fulfillment('stripe','in_race','$USER_ID','subscription_grant','studio',1500,now()+interval '30 days',now(),null,false,false);"
OUT_A=$(mktemp); OUT_B=$(mktemp)
psql "$DB" -t -A -v ON_ERROR_STOP=1 -c "$CALL" > "$OUT_A" 2>&1 &
PID_A=$!
psql "$DB" -t -A -v ON_ERROR_STOP=1 -c "$CALL" > "$OUT_B" 2>&1 &
PID_B=$!
RC_A=0; RC_B=0
wait $PID_A || RC_A=$?
wait $PID_B || RC_B=$?

BOTH="$(cat "$OUT_A")
$(cat "$OUT_B")"
rm -f "$OUT_A" "$OUT_B"

APPLIED_TRUE=$(printf '%s' "$BOTH" | grep -c '"applied": true' || true)
REPLAY_TRUE=$(printf '%s' "$BOTH" | grep -c '"replay": true' || true)

GRANTS=$(psql "$DB" -t -A -c "select count(*) from public.ledger_entries where user_id='$USER_ID' and type='cycle_reset';")
ROWS=$(psql "$DB" -t -A -c "select count(*) from public.billing_transactions where user_id='$USER_ID';")

psql "$DB" -q -c "
  delete from public.ledger_entries where user_id='$USER_ID';
  delete from public.billing_transactions where user_id='$USER_ID';
  delete from public.profiles where id='$USER_ID';
  delete from auth.users where id='$USER_ID';
"

test "$RC_A" = "0" && test "$RC_B" = "0" || {
  echo "FAIL: a concurrent caller errored instead of replaying (rc=$RC_A/$RC_B)"
  printf '%s\n' "$BOTH"; exit 1; }
test "$APPLIED_TRUE" = "1" || { echo "FAIL: expected exactly 1 applied, got $APPLIED_TRUE"; printf '%s\n' "$BOTH"; exit 1; }
test "$REPLAY_TRUE" = "1" || { echo "FAIL: expected exactly 1 replay, got $REPLAY_TRUE"; printf '%s\n' "$BOTH"; exit 1; }
test "$GRANTS" = "1" || { echo "FAIL: expected 1 grant, got $GRANTS"; exit 1; }
test "$ROWS" = "1" || { echo "FAIL: expected 1 applied transaction, got $ROWS"; exit 1; }
echo "OK: concurrent delivery granted once; loser replayed cleanly"
