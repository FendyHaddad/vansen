#!/usr/bin/env bash
#
# Stop staging completely: the Supabase containers, and any `functions serve`
# or `ng serve` left behind by a closed terminal or a crash. `./dev.sh` cleans
# up after itself on Ctrl-C, so this is the "make sure nothing is still
# running" script — safe to run when nothing is up.
#
# Touches only this machine. Production is never involved.

set -uo pipefail

NODE_VERSION="22.23.1"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

# Orphans first: stopping the containers while a `functions serve` still holds
# the port leaves it spinning on connection errors.
PATTERNS=('scripts/stage.mjs' 'supabase functions serve' 'ng serve')
for pattern in "${PATTERNS[@]}"; do
  pids="$(pgrep -f "$pattern" || true)"
  [ -n "$pids" ] || continue
  printf 'stopping %s (%s)\n' "$pattern" "$(echo "$pids" | tr '\n' ' ' | sed 's/ $//')"
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
done

# Give them the same grace stage.mjs does before insisting.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  pgrep -f 'scripts/stage.mjs|supabase functions serve|ng serve' >/dev/null || break
  sleep 1
done
pids="$(pgrep -f 'scripts/stage.mjs|supabase functions serve|ng serve' || true)"
if [ -n "$pids" ]; then
  # shellcheck disable=SC2086
  kill -9 $pids 2>/dev/null || true
fi

if [ -f "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" >/dev/null
  nvm use "$NODE_VERSION" >/dev/null 2>&1 || true
fi

if docker info >/dev/null 2>&1; then
  supabase stop >/dev/null 2>&1 || true
else
  echo "Docker is not running; no containers to stop."
fi

printf '\033[32m✓\033[0m staging stopped.\n'
