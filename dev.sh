#!/usr/bin/env bash
#
# Start staging: the Supabase containers, the five Edge Functions, a job-worker
# tick and `ng serve`, all against the local stack. Nothing here touches
# production — the functions run from this working tree, so every edit is live
# on save and there is nothing to deploy.
#
# Ctrl-C stops the functions and the dev server but leaves the containers up,
# which is what you want between runs. `./kill.sh` stops those too.
#
# Usage:
#   ./dev.sh            start staging
#   ./dev.sh --seed     reseed the three accounts first, then start

set -euo pipefail

NODE_VERSION="22.23.1"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

fail() { printf '\033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }

[ -f "$HOME/.nvm/nvm.sh" ] || fail "nvm not found at ~/.nvm/nvm.sh"
# shellcheck disable=SC1091
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" >/dev/null
nvm use "$NODE_VERSION" >/dev/null 2>&1 || fail "node $NODE_VERSION not installed (nvm install $NODE_VERSION)"

for tool in supabase npx docker; do
  command -v "$tool" >/dev/null || fail "$tool is not on PATH"
done
docker info >/dev/null 2>&1 || fail "Docker is not running"

[ -f supabase/.env.staging ] || fail "supabase/.env.staging is missing — copy supabase/.env.staging.example and fill it in"

# Seeding needs the containers, not the functions: the accounts go in through
# GoTrue and psql directly.
if [ "${1:-}" = "--seed" ]; then
  supabase status >/dev/null 2>&1 || supabase start
  node scripts/stage-seed.mjs
fi

exec node scripts/stage.mjs
