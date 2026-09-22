#!/usr/bin/env bash
#
# Vansen production deployment.
#
# Deploys all five Supabase backend functions, then the Cloudflare Worker that
# serves the Angular bundle, stamps the release manifest, and proves the
# running system matches what was just sent. `api` goes first because it
# owns pricing: a stale browser against a new server shows a stale price,
# a new browser against a stale server makes broken requests.
#
# Never commits, never branches, never pushes. Refuses a dirty tree because
# GIT_REVISION in the manifest promises the deployed code is the committed code.
#
# Output is one progress line plus a verdict. Every command's full output goes
# to a log file whose path is printed on failure.
#
# Usage:
#   ./deploy.sh                 full gates, then deploy
#   ./deploy.sh --dry-run       gates and preflight only, deploy nothing
#   ./deploy.sh --skip-verify   deploy without gates (asks for 'unverified')
#   ./deploy.sh --yes           no confirmation prompt (for a rerun)
#
# Environment:
#   VANSEN_PROJECT_REF  Supabase project ref (default: the production project)
#   VANSEN_LOCAL_DB     Postgres URL for the SQL gates. Unset (the normal
#                       case) the script starts the local Supabase stack
#                       itself, runs the gates against it, and stops it after.

set -euo pipefail

PROJECT_REF="${VANSEN_PROJECT_REF:-bnorhcxhvxydkgvcxjad}"
NODE_VERSION="22.23.1"
FUNCTIONS_URL="https://${PROJECT_REF}.supabase.co/functions/v1/api"
WEB_URL="https://vansen.fendyhaddad-d36.workers.dev/"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DRY_RUN=0
SKIP_VERIFY=0
ASSUME_YES=0

usage() { sed -n '3,27p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --skip-verify) SKIP_VERIFY=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------------------
# Output: one redrawn progress line, one verdict line, everything else logged
# ---------------------------------------------------------------------------
LOG="$(mktemp -t vansen-deploy)"
STEP_OUT="$(mktemp -t vansen-step)"
TTY=0; [ -t 1 ] && TTY=1
TOTAL=7
DONE=0

# draw LABEL SPINNER ELAPSED: one line, redrawn in place.
draw() {
  local width=24
  local filled=$(( DONE * width / TOTAL ))
  local fill rest
  fill="$(printf '%*s' "$filled" '')"; fill="${fill// /█}"
  rest="$(printf '%*s' $(( width - filled )) '')"; rest="${rest// /░}"
  printf '\r\033[K\033[2m[%s%s]\033[0m %d/%d  %s %s \033[2m%ss\033[0m' \
    "$fill" "$rest" "$DONE" "$TOTAL" "$2" "$1" "$3"
}

# A step can be quiet for a minute (gates, wrangler upload). The spinner and
# the elapsed seconds are the proof that it is working and not hung.
SPIN_PID=""
spin_stop() {
  [ -n "$SPIN_PID" ] || return 0
  kill "$SPIN_PID" 2>/dev/null || true
  wait "$SPIN_PID" 2>/dev/null || true
  SPIN_PID=""
}

progress() {
  spin_stop
  if [ "$TTY" != "1" ]; then
    printf '[%d/%d] %s\n' "$DONE" "$TOTAL" "$1"
    return 0
  fi
  (
    trap - ERR EXIT
    frames=(⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏); i=0; started=$SECONDS
    while :; do
      draw "$1" "${frames[i % 10]}" "$(( SECONDS - started ))"
      i=$(( i + 1 ))
      sleep 0.1
    done
  ) &
  SPIN_PID=$!
}

tick() { DONE=$(( DONE + 1 )); }

clearline() { spin_stop; [ "$TTY" = "1" ] && printf '\r\033[K'; return 0; }

# The local database we started, if any. Stopped before every exit so a
# failed run never leaves Docker containers behind.
STARTED_DB=0
LOCAL_DB_URL='postgresql://postgres:postgres@127.0.0.1:54322/postgres'

cleanup() {
  [ "$STARTED_DB" = "1" ] || return 0
  STARTED_DB=0
  progress "stopping local database"
  npm run db:test:stop >>"$LOG" 2>&1 || true
}
trap 'cleanup; spin_stop' EXIT

# fail REASON [DETAIL]: the last thing printed, always says why.
fail() {
  trap - ERR
  cleanup
  clearline
  printf '\033[31m✗ DEPLOY FAILED\033[0m — %s\n' "$1" >&2
  [ -n "${2:-}" ] && printf '%s\n' "$2" | sed 's/^/    /' >&2
  printf '    log: %s\n' "$LOG" >&2
  exit 1
}

trap 'fail "unexpected error at line $LINENO: $BASH_COMMAND"' ERR

# Why a step failed, in as few lines as possible. `npm run verify` prints a
# summary table; quote its FAIL/SKIPPED rows. Otherwise the tail of the output.
detail() {
  if grep -q '─── verify-all ───' "$STEP_OUT"; then
    awk '/─── verify-all ───/{f=1;next} f && /^(FAIL|SKIPPED)/' "$STEP_OUT"
    # The failing check's own last words, from before the summary table.
    awk '/─── verify-all ───/{exit} /[Ee][Rr][Rr][Oo][Rr]|FAIL|failed/' "$STEP_OUT" | tail -n 4 | sed 's/^/  /'
    return 0
  fi
  grep -v '^\s*$' "$STEP_OUT" | tail -n 8
}

# run REASON CMD...: run quietly, log everything, fail with REASON + detail.
run() {
  local reason="$1"; shift
  printf '\n$ %s\n' "$*" >> "$LOG"
  if "$@" >"$STEP_OUT" 2>&1; then
    cat "$STEP_OUT" >> "$LOG"
    return 0
  fi
  cat "$STEP_OUT" >> "$LOG"
  fail "$reason" "$(detail)"
}

# Ask for JSON explicitly: the CLI's default output is a table in a terminal
# and JSON in a pipe, which is how this read came back empty on a real run.
functionVersion() {
  local name="$1"
  supabase functions list --project-ref "$PROJECT_REF" --output json 2>>"$LOG" \
    | jq -r --arg name "$name" '(if type == "array" then . else .functions end)[] | select(.slug == $name) | .version'
}

cd "$REPO_ROOT"

# ---------------------------------------------------------------------------
# 1. Preflight
# ---------------------------------------------------------------------------
progress "preflight"

[ -f "$HOME/.nvm/nvm.sh" ] || fail "nvm not found at ~/.nvm/nvm.sh"
# shellcheck disable=SC1091
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" >/dev/null
nvm use "$NODE_VERSION" >/dev/null 2>&1 || fail "node $NODE_VERSION not installed (nvm install $NODE_VERSION)"

for tool in supabase npx git curl jq deno; do
  command -v "$tool" >/dev/null || fail "$tool is not on PATH"
done

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "main" ] || fail "on branch '$BRANCH'; Vansen deploys from main only"

DIRTY="$(git status --porcelain)"
[ -z "$DIRTY" ] || fail "working tree is dirty — commit first (this script never commits)" "$DIRTY"

REVISION="$(git rev-parse --short HEAD)"

CATALOG_VERSION="$(grep -o "CATALOG_VERSION = '[^']*'" src/app/core/catalog/model-families.ts | head -1 | cut -d"'" -f2)"
[ -n "$CATALOG_VERSION" ] || fail "could not read CATALOG_VERSION from src/app/core/catalog/model-families.ts"

LIVE="$(curl -fsS "$FUNCTIONS_URL/manifest" 2>>"$LOG")" || fail "live manifest unreachable at $FUNCTIONS_URL/manifest"
LIVE_CATALOG="$(printf '%s' "$LIVE" | jq -r '.catalogVersion // "unknown"')"
tick

# ---------------------------------------------------------------------------
# 2. Local database for the SQL gates
# ---------------------------------------------------------------------------
if [ "$SKIP_VERIFY" = "1" ] && [ "$ASSUME_YES" != "1" ]; then
  clearline
  read -r -p "Deploy to PRODUCTION with no gates? type 'unverified': " reply
  [ "$reply" = "unverified" ] || fail "aborted"
fi

if [ "$SKIP_VERIFY" != "1" ] && [ -z "${VANSEN_LOCAL_DB:-}" ]; then
  progress "starting local database"
  docker info >>"$LOG" 2>&1 || fail "Docker is not running — the SQL gates need the local Supabase stack"
  STARTED_DB=1
  run "could not start the local database for the SQL gates" npm run db:test:start
  export VANSEN_LOCAL_DB="$LOCAL_DB_URL"
fi
tick

# ---------------------------------------------------------------------------
# 3. Gates (or a bare build when skipped)
# ---------------------------------------------------------------------------

if [ "$SKIP_VERIFY" = "1" ]; then
  progress "building (gates skipped)"
  run "production build failed" npx ng build --configuration production
fi

if [ "$SKIP_VERIFY" != "1" ]; then
  progress "gates (npm run verify)"
  run "gates failed — nothing was deployed" npm run verify
fi

[ -d dist/vansen/browser ] || fail "dist/vansen/browser missing — nothing to upload"
cleanup
tick

if [ "$DRY_RUN" = "1" ]; then
  clearline
  printf '\033[32m✓ DRY RUN OK\033[0m — preflight and gates passed, deployed nothing (%s, catalog %s)\n' "$REVISION" "$CATALOG_VERSION"
  exit 0
fi

# ---------------------------------------------------------------------------
# Confirm
# ---------------------------------------------------------------------------
if [ "$ASSUME_YES" != "1" ]; then
  clearline
  read -r -p "Deploy $REVISION (catalog $CATALOG_VERSION, live $LIVE_CATALOG) to PRODUCTION $PROJECT_REF? [y/N] " reply
  case "$reply" in [yY]*) ;; *) fail "aborted" ;; esac
fi

# ---------------------------------------------------------------------------
# 4. api first (it owns pricing)
# ---------------------------------------------------------------------------
progress "deploying all backend functions"
COMPONENT_RECEIPT="${LOG}.components.json"
run "backend deploy failed — the web bundle was NOT deployed" \
  node scripts/deploy-backend.mjs "$PROJECT_REF" "$REVISION" "$COMPONENT_RECEIPT"
API_VERSION="$(jq -r '.components.api.version' "$COMPONENT_RECEIPT")"
JOB_WORKER_VERSION="$(jq -r '.components["job-worker"].version' "$COMPONENT_RECEIPT")"

tick

# ---------------------------------------------------------------------------
# 5. Web bundle
# ---------------------------------------------------------------------------
progress "deploying cloudflare worker"
run "worker deploy failed — api is already on $CATALOG_VERSION, rerun this script" \
  npx wrangler deploy
tick

# ---------------------------------------------------------------------------
# 6. Stamp the manifest
# ---------------------------------------------------------------------------
progress "stamping manifest"
# Setting secrets redeploys the function and bumps its version by one, so
# stamp the predicted version and check the prediction below.
STAMPED_API_VERSION="v$((API_VERSION + 1))"
STAMPED_VERSION="v$((JOB_WORKER_VERSION + 1))"
DEPLOYED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

run "could not stamp the manifest" \
  supabase secrets set \
    GIT_REVISION="$REVISION" \
    WORKER_VERSION="$STAMPED_VERSION" \
    DEPLOYED_AT="$DEPLOYED_AT" \
    --project-ref "$PROJECT_REF"
tick

# ---------------------------------------------------------------------------
# 7. Prove it
# ---------------------------------------------------------------------------
progress "verifying running system"
sleep 5  # the function restarts on a secret change

MANIFEST="$(curl -fsS "$FUNCTIONS_URL/manifest" 2>>"$LOG")" || fail "manifest unreachable after deploy"
printf '\n$ manifest\n%s\n' "$MANIFEST" >> "$LOG"

MISMATCH=""
check() {
  local label="$1" actual="$2" expected="$3"
  [ "$actual" = "$expected" ] && return 0
  MISMATCH="${MISMATCH}${label}: got ${actual}, expected ${expected}"$'\n'
}

check "gitRevision"    "$(printf '%s' "$MANIFEST" | jq -r '.gitRevision')"    "$REVISION"
check "catalogVersion" "$(printf '%s' "$MANIFEST" | jq -r '.catalogVersion')" "$CATALOG_VERSION"
check "workerVersion"  "$(printf '%s' "$MANIFEST" | jq -r '.workerVersion')"  "$STAMPED_VERSION"
check "api version"    "v$(functionVersion api)"                           "$STAMPED_API_VERSION"
for component in job-worker cleanup-worker stripe-webhook appstore-webhook; do
  before="$(jq -r --arg name "$component" '.components[$name].version' "$COMPONENT_RECEIPT")"
  check "$component version" "v$(functionVersion "$component")" "v$((before + 1))"
done
check "capabilities"   "$(curl -fsS "$FUNCTIONS_URL/capabilities" 2>>"$LOG" | jq -r '.catalogVersion')" "$CATALOG_VERSION"
check "web app"        "$(curl -fsS -o /dev/null -w '%{http_code}' "$WEB_URL" 2>>"$LOG" || true)" "200"
tick

[ -z "$MISMATCH" ] || fail "deployed, but the running system disagrees with what was sent" "$MISMATCH"
# All five post-stamp versions were checked above; preserve the final inventory.
jq '.components |= with_entries(.value.version += 1)' "$COMPONENT_RECEIPT" > "${COMPONENT_RECEIPT}.final"
mv "${COMPONENT_RECEIPT}.final" "$COMPONENT_RECEIPT"

clearline
printf '\033[32m✓ DEPLOYED\033[0m %s · catalog %s · api %s · %s\n' "$REVISION" "$CATALOG_VERSION" "$STAMPED_API_VERSION" "$WEB_URL"
printf '  Component deployment receipt: %s\n' "$COMPONENT_RECEIPT"
printf '  A deploy is not a release: record it in docs/superpowers/plans/2026-09-20-release-evidence.md\n'
