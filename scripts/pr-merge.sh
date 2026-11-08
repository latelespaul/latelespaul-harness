#!/bin/zsh
# Merge a GitHub PR safely, for use from a phone (Telegram session).
#   pr-merge.sh <owner/repo|repo> <pr-number> [--dry-run]
# A bare repo name uses your gh login as owner. Refuses drafts, conflicts,
# failing or pending checks, and PRs whose base is not the default branch
# (stacked PRs: merge the parent first). Squash-merges and deletes the branch.
set -euo pipefail

repo=${1:?usage: pr-merge.sh <owner/repo> <pr-number> [--dry-run]}
num=${2:?usage: pr-merge.sh <owner/repo> <pr-number> [--dry-run]}
dry=${3:-}
[[ $num == <-> ]] || { print -u2 "PR number must be numeric"; exit 2 }
[[ $repo == */* ]] || repo="$(gh api user -q .login)/$repo"

info=$(gh pr view $num -R $repo --json state,isDraft,mergeable,baseRefName,title,url)
state=$(jq -r .state <<<$info); draft=$(jq -r .isDraft <<<$info)
mergeable=$(jq -r .mergeable <<<$info); base=$(jq -r .baseRefName <<<$info)
title=$(jq -r .title <<<$info); url=$(jq -r .url <<<$info)
default=$(gh repo view $repo --json defaultBranchRef -q .defaultBranchRef.name)

fail() { print "NOT MERGED: $repo#$num ($title): $1"; exit 1 }
[[ $state == OPEN ]]         || fail "state is $state"
[[ $draft == false ]]        || fail "it is a draft"
[[ $base == $default ]]      || fail "base is '$base', not '$default' (stacked PR; merge its parent first)"
[[ $mergeable != CONFLICTING ]] || fail "it has merge conflicts"

checks=$(gh pr checks $num -R $repo --json bucket -q '[.[].bucket] | group_by(.) | map("\(.[0])=\(length)") | join(" ")' 2>/dev/null || true)
[[ $checks == *fail=* || $checks == *cancel=* ]] && fail "checks failing ($checks)"
[[ $checks == *pending=* ]] && fail "checks still running ($checks)"

if [[ $dry == --dry-run ]]; then
  print "WOULD MERGE: $repo#$num ($title) into $base, checks: ${checks:-none}"; exit 0
fi
gh pr merge $num -R $repo --squash --delete-branch >/dev/null
print "MERGED: $repo#$num ($title) into $base. $url"
