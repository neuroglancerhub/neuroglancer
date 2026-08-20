#!/usr/bin/env bash
#
# Sync the fork with upstream neuroglancer.
#
#   1. fetch upstream and fast-forward master to it
#   2. rebase janelia-release onto master
#   3. typecheck and test the result
#
# Nothing is pushed. Review, then:
#   git push --force-with-lease origin janelia-release
#
# Conflict resolutions are remembered by git rerere (enabled below), so a
# conflict resolved during one sync is replayed automatically in the next.
set -euo pipefail

RELEASE_BRANCH=janelia-release
UPSTREAM_REMOTE=upstream
UPSTREAM_BRANCH=master

cd "$(dirname "$0")/.."

git config rerere.enabled true
git config rerere.autoupdate true

if ! git diff-index --quiet HEAD --; then
  echo "working tree is dirty; commit or stash first" >&2
  exit 1
fi

echo "==> fetching $UPSTREAM_REMOTE"
git fetch "$UPSTREAM_REMOTE" --tags

echo "==> fast-forwarding master"
git checkout master
git merge --ff-only "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH"

behind=$(git rev-list --count "$RELEASE_BRANCH..master")
echo "==> $RELEASE_BRANCH is $behind commit(s) behind master"

echo "==> rebasing $RELEASE_BRANCH onto master"
git checkout "$RELEASE_BRANCH"
git rebase master

echo "==> installing dependencies if the lockfile moved"
if ! git diff --quiet ORIG_HEAD..HEAD -- package-lock.json; then
  npm ci
fi

echo "==> typecheck"
npm run typecheck

echo "==> tests"
npm test

cat <<SUMMARY

Sync complete.
  master:          $(git log -1 --format='%h %s' master)
  $RELEASE_BRANCH: $(git rev-list --count master..HEAD) commit(s) on top

Review the delta with:
  git diff master..$RELEASE_BRANCH --stat

Publish with:
  git push --force-with-lease origin $RELEASE_BRANCH
SUMMARY
