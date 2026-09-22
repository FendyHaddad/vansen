#!/usr/bin/env bash
set -euo pipefail
: "${VANSEN_LOCAL_DB:?disposable local database required}"
case "$VANSEN_LOCAL_DB" in *127.0.0.1*|*localhost*) ;; *) exit 2;; esac
USER_ID='bbee0000-0000-4000-8000-000000000005'
OUT="$(mktemp -d)"
cleanup() {
  psql "$VANSEN_LOCAL_DB" -X -q -v ON_ERROR_STOP=1 -c "delete from auth.users where id='$USER_ID'" >/dev/null
  rm -rf "$OUT"
}
trap cleanup EXIT
psql "$VANSEN_LOCAL_DB" -X -q -v ON_ERROR_STOP=1 -c "insert into auth.users(id,email) values('$USER_ID','rate-concurrency@example.com')" >/dev/null
pids=()
for i in $(seq 1 30); do
  psql "$VANSEN_LOCAL_DB" -X -At -v ON_ERROR_STOP=1 -c "select public.fn_take_request_slot('$USER_ID','generation')->>'allowed'" > "$OUT/$i" &
  pids+=("$!")
done
for pid in "${pids[@]}"; do wait "$pid"; done
allowed="$(cat "$OUT"/* | awk '$0=="true" {n++} END {print n+0}')"
[ "$allowed" = 20 ] || { echo "Expected 20 accepted concurrent requests, got $allowed"; exit 1; }
echo 'OK: concurrent generation requests share one atomic 20-request budget'
