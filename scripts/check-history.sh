#!/usr/bin/env bash
# Checks out each commit in BASE..HEAD in a scratch worktree and runs the
# type check and unit tests (plus cargo test when a commit touches src-tauri),
# then confirms HEAD's tree equals EXPECTED_TREE when given.
# Usage: scripts/check-history.sh <base> [expected-tree]
set -euo pipefail
base=${1:?base ref}
expected=${2:-}
repo=$(git rev-parse --show-toplevel)
scratch=$(mktemp -d)
trap 'git -C "$repo" worktree remove --force "$scratch" >/dev/null 2>&1 || true' EXIT
git -C "$repo" worktree add --detach -q "$scratch" HEAD
export CARGO_TARGET_DIR="$repo/src-tauri/target/history-check"
export PATH="/opt/homebrew/opt/rustup/bin:$PATH"

for c in $(git -C "$repo" rev-list --reverse "$base..HEAD"); do
  subject=$(git -C "$repo" log -1 --format='%h %s' "$c")
  git -C "$scratch" checkout -q "$c"
  lock=$(git -C "$scratch" rev-parse HEAD:pnpm-lock.yaml)
  if [ "$lock" != "${installed:-}" ]; then
    (cd "$scratch" && pnpm install --frozen-lockfile --silent >/dev/null) || { echo "FAIL (deps) $subject"; exit 1; }
    installed=$lock
  fi
  (cd "$scratch" && npx tsc --noEmit >/dev/null && npx vitest run >/dev/null) || { echo "FAIL (ts)   $subject"; exit 1; }
  if git -C "$repo" show --name-only --format= "$c" | grep -q '^src-tauri/'; then
    (cd "$scratch/src-tauri" && cargo test -q >/dev/null 2>&1) || { echo "FAIL (rust) $subject"; exit 1; }
  fi
  echo "ok          $subject"
done

if [ -n "$expected" ]; then
  actual=$(git -C "$repo" rev-parse 'HEAD^{tree}')
  [ "$actual" = "$expected" ] || { echo "FAIL tree $actual != $expected"; exit 1; }
  echo "tree matches $expected"
fi
