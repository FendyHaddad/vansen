#!/usr/bin/env bash
#
# Vansen production deployment.
#
# Deploys the Supabase `api` Edge Function and the Cloudflare Worker that
# serves the Angular bundle, then stamps the release manifest and proves the
# running system matches what was just sent.
#
# Order is not arbitrary. `api` goes first because it owns pricing: the server
# stamps its own CATALOG_VERSION onto every charge, so a browser running the
# previous bundle against the new server is merely showing a stale price,
# while the reverse — a new composer offering tiers the old server refuses —
# is a broken request.
#
# This script never commits, never branches, never pushes. It refuses to run
# on a dirty tree instead, because GIT_REVISION in the manifest is a promise
# that the deployed code is the code at that commit, and a dirty tree makes
# that promise false.
#
# Usage:
#   ./deploy.sh                 full gates, then deploy
#   ./deploy.sh --dry-run       gates and preflight only, deploy nothing
#   ./deploy.sh --skip-verify   deploy without gates (asks twice)
#   ./deploy.sh --yes           no confirmation prompt (for a rerun)
#
# Environment:
#   VANSEN_PROJECT_REF  Supabase project ref (default: the production project)
#   VANSEN_LOCAL_DB     Postgres URL for the SQL gates. Without it `npm run
#                       verify` scores the SQL integration tests as a FAILURE,
#                       which is deliberate: a skipped check is not a passed
#                       check. Start one with `npm run db:test:start`.

set -euo pipefail

PROJECT_REF="${VANSEN_PROJECT_REF:-bnorhcxhvxydkgvcxjad}"
NODE_VERSION="22.23.1"
FUNCTIONS_URL="https://${PROJECT_REF}.supabase.co/functions/v1/api"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DRY_RUN=0
SKIP_VERIFY=0
ASSUME_YES=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --skip-verify) SKIP_VERIFY=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    -h|--help) sed -n '3,31p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

ok()   { printf '    \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '    \033[33m!\033[0m %s\n' "$1"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

# The Supabase CLI draws a progress spinner on STDOUT when it is attached to a
# terminal, so `... | jq` gets "\u2819{...}" and dies on the first byte. It only
# shows up in an interactive shell, never in a piped test run, which is exactly
# how it reached a live deploy. Drop everything before the opening brace.
apiVersion() {
  supabase functions list --project-ref "$PROJECT_REF" 2>/dev/null \
    | tr -d '\r' | sed -n 's/^[^{]*\({.*\)$/\1/p' | head -1 \
    | jq -r '.functions[] | select(.slug=="api") | .version'
}

cd "$REPO_ROOT"

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------
step "Preflight"

[ -f "$HOME/.nvm/nvm.sh" ] || die "nvm not found at ~/.nvm/nvm.sh"
# shellcheck disable=SC1091
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" >/dev/null
nvm use "$NODE_VERSION" >/dev/null || die "node $NODE_VERSION not installed (nvm install $NODE_VERSION)"
ok "node $(node --version)"

for tool in supabase npx git curl jq deno; do
  command -v "$tool" >/dev/null || die "$tool is not on PATH"
done
ok "supabase, npx, git, curl, jq, deno present"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "main" ] || die "on branch '$BRANCH'; Vansen deploys from main only"

# A dirty tree would make GIT_REVISION a lie. Say exactly what is dirty rather
# than making someone run git status to find out.
if [ -n "$(git status --porcelain)" ]; then
  git status --short
  die "working tree is dirty — commit first (this script never commits for you)"
fi

REVISION="$(git rev-parse --short HEAD)"
ok "branch main, clean, at $REVISION"

CATALOG_VERSION="$(grep -o "CATALOG_VERSION = '[^']*'" src/app/core/catalog/model-families.ts | head -1 | cut -d"'" -f2)"
[ -n "$CATALOG_VERSION" ] || die "could not read CATALOG_VERSION from the catalog"
ok "catalog $CATALOG_VERSION"

LIVE="$(curl -fsS "$FUNCTIONS_URL/manifest")"
LIVE_CATALOG="$(printf '%s' "$LIVE" | jq -r '.catalogVersion // "unknown"')"
LIVE_REVISION="$(printf '%s' "$LIVE" | jq -r '.gitRevision // "unknown"')"
ok "currently live: catalog $LIVE_CATALOG from $LIVE_REVISION"

# ---------------------------------------------------------------------------
# Gates
# ---------------------------------------------------------------------------
step "Gates"

if [ "$SKIP_VERIFY" = "1" ]; then
  warn "SKIPPING npm run verify — nothing below is evidence of anything"
  if [ "$ASSUME_YES" != "1" ]; then
    read -r -p "    Deploy to production with no gates? type 'unverified': " reply
    [ "$reply" = "unverified" ] || die "aborted"
  fi
fi

if [ "$SKIP_VERIFY" != "1" ]; then
  [ -n "${VANSEN_LOCAL_DB:-}" ] || warn "VANSEN_LOCAL_DB unset — the SQL gates will be scored as a FAILURE, by design"
  npm run verify || die "gates failed — nothing was deployed"
  ok "all gates green"
fi

# `npm run verify` builds with --configuration production as its last check, so
# dist/ is already the artifact we want. Build here only when gates were
# skipped, so wrangler never uploads a stale or missing bundle.
if [ "$SKIP_VERIFY" = "1" ]; then
  npx ng build --configuration production || die "build failed"
fi
[ -d dist/vansen/browser ] || die "dist/vansen/browser missing — nothing to upload"
ok "bundle ready at dist/vansen/browser"

if [ "$DRY_RUN" = "1" ]; then
  step "Dry run"
  ok "preflight and gates passed; deployed nothing"
  exit 0
fi

# ---------------------------------------------------------------------------
# Confirm
# ---------------------------------------------------------------------------
if [ "$ASSUME_YES" != "1" ]; then
  step "About to deploy to PRODUCTION ($PROJECT_REF)"
  printf '    commit  %s\n    catalog %s  (live: %s)\n' "$REVISION" "$CATALOG_VERSION" "$LIVE_CATALOG"
  read -r -p "    Continue? [y/N] " reply
  case "$reply" in [yY]*) ;; *) die "aborted" ;; esac
fi

# ---------------------------------------------------------------------------
# Deploy: api first (it owns pricing), then the web bundle
# ---------------------------------------------------------------------------
step "Deploying Edge Function: api"
# --no-verify-jwt: the gateway authenticates requests itself and serves public
# routes (/manifest, /capabilities, the Stripe return) that carry no JWT.
supabase functions deploy api --no-verify-jwt --project-ref "$PROJECT_REF" \
  || die "api deploy failed — the web bundle was NOT deployed"

API_VERSION="$(apiVersion)"
[ -n "$API_VERSION" ] || die "deployed api but could not read its version back"
ok "api is now version $API_VERSION"

step "Deploying Cloudflare Worker"
npx wrangler deploy || die "worker deploy failed — api is already on $CATALOG_VERSION, rerun this script"
ok "worker deployed"

# ---------------------------------------------------------------------------
# Stamp the manifest
# ---------------------------------------------------------------------------
step "Stamping the release manifest"

# Writing Edge Function secrets itself redeploys the function, which bumps its
# version by one. Stamping the version we just read would therefore record a
# number that is stale the instant it is written — the exact defect that made
# the manifest report v51 against a real v55 on 2026-09-21. Predict the bump,
# then check the prediction below.
STAMPED_VERSION="v$((API_VERSION + 1))"
DEPLOYED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

supabase secrets set \
  GIT_REVISION="$REVISION" \
  WORKER_VERSION="$STAMPED_VERSION" \
  DEPLOYED_AT="$DEPLOYED_AT" \
  --project-ref "$PROJECT_REF" >/dev/null || die "could not stamp the manifest"
ok "stamped $REVISION / $STAMPED_VERSION / $DEPLOYED_AT"

# ---------------------------------------------------------------------------
# Prove it
# ---------------------------------------------------------------------------
step "Verifying the running system"

# The function restarts on a secret change; give it a moment before asking.
sleep 5

MANIFEST="$(curl -fsS "$FUNCTIONS_URL/manifest")" || die "manifest unreachable after deploy"
printf '%s\n' "$MANIFEST" | jq .

FAILURES=0
check() {
  local label="$1" actual="$2" expected="$3"
  [ "$actual" = "$expected" ] && { ok "$label = $actual"; return 0; }
  warn "$label = $actual, expected $expected"
  FAILURES=$((FAILURES + 1))
}

check "gitRevision"    "$(printf '%s' "$MANIFEST" | jq -r '.gitRevision')"    "$REVISION"
check "catalogVersion" "$(printf '%s' "$MANIFEST" | jq -r '.catalogVersion')" "$CATALOG_VERSION"
check "workerVersion"  "$(printf '%s' "$MANIFEST" | jq -r '.workerVersion')"  "$STAMPED_VERSION"

REAL_VERSION="$(apiVersion)"
check "api version on disk" "v$REAL_VERSION" "$STAMPED_VERSION"

LIVE_CAPS="$(curl -fsS "$FUNCTIONS_URL/capabilities" | jq -r '.catalogVersion')"
check "capabilities catalog" "$LIVE_CAPS" "$CATALOG_VERSION"

WEB_STATUS="$(curl -fsS -o /dev/null -w '%{http_code}' https://vansen.fendyhaddad-d36.workers.dev/)"
check "web app" "$WEB_STATUS" "200"

step "Result"
[ "$FAILURES" = "0" ] || die "$FAILURES manifest check(s) disagreed with the running system — read the warnings above before telling anyone this shipped"

ok "production is on $REVISION, catalog $CATALOG_VERSION, api $STAMPED_VERSION"
printf '\n    Record it in docs/superpowers/plans/2026-09-20-release-evidence.md.\n'
printf '    A green run here is a deploy, not a release: the per-family smokes\n'
printf '    and the authenticated browser pass in that document are still owed.\n\n'
