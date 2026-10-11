#!/usr/bin/env bash
# Runs .github/workflows/ci.yml's steps locally, the way a runner would:
# a fresh clone of the committed HEAD (no .env files, no node_modules, no
# .data, nothing uncommitted), a clean environment holding only what the
# workflow and a runner set, and Node 24.
#
#   scripts/ci-local.sh [scratch-dir]
#
# The scratch dir (default: a new temp dir) is wiped first. Keep the steps
# below in step with the workflow's.
set -euo pipefail

repo="$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)"
dir="${1:-$(mktemp -d -t bot-ci-XXXXXX)}"
rm -rf "$dir"
git clone --quiet --no-local "$repo" "$dir"
git -C "$dir" checkout --quiet --detach "$(git -C "$repo" rev-parse HEAD)"

node_bin="$(dirname "$(command -v node)")"
if [[ "$(node --version)" != v24.* ]]; then
  echo "ci-local: Node 24 is required (found $(node --version)); try: nvm use 24" >&2
  exit 1
fi

# Only what the workflow (`env:`) and a GitHub runner set; nothing from this shell.
run() {
  echo "::: $*"
  (cd "$dir" && env -i \
    HOME="$HOME" \
    PATH="$node_bin:/usr/local/bin:/usr/bin:/bin" \
    CI=true \
    GITHUB_ACTIONS=true \
    NEXT_TELEMETRY_DISABLED=1 \
    "$@")
}

echo "ci-local: $(git -C "$dir" log --oneline -1) in $dir"
run npm ci
run npm test
run npm run typecheck
run npm run build
echo "ci-local: all steps passed"
