#!/usr/bin/env bash
set -euo pipefail

UPSTREAM=https://github.com/Stremio/stremio-linux-shell.git
PREFIX=shell

git remote add upstream "$UPSTREAM" 2>/dev/null || true
git fetch upstream main

LAST_SHA=$(cat .ci/last-tested-upstream-sha 2>/dev/null || echo '')
NEW_SHA=$(git rev-parse upstream/main)

if [[ "$LAST_SHA" == "$NEW_SHA" ]]; then
  echo "upstream unchanged ($NEW_SHA)"
  exit 0
fi

if ! git subtree pull --prefix=$PREFIX upstream main --squash -m "subtree: rebase shell on upstream/main"; then
  TITLE="Upstream rebase conflict on $NEW_SHA"
  BODY=$(printf 'Failed to subtree-pull upstream/main.\n\nUpstream HEAD: %s\nPrevious tested: %s\n' "$NEW_SHA" "$LAST_SHA")
  EXISTING=$(gh issue list --search "$TITLE in:title" --state open --json number --jq '.[0].number' 2>/dev/null || echo '')
  if [[ -z "$EXISTING" ]]; then
    gh issue create --title "$TITLE" --body "$BODY"
  fi
  exit 1
fi

echo "$NEW_SHA" > .ci/last-tested-upstream-sha
git add .ci/last-tested-upstream-sha
git commit -m "ci: bump last-tested-upstream-sha to $NEW_SHA" || true
git push origin HEAD:main
