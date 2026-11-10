#!/bin/zsh
# Merge a GitHub PR safely, for use from a phone (Telegram session).
#   pr-merge.sh <owner/repo|repo> <pr-number> [--dry-run]
# A bare repo name uses your gh login as owner. Refuses drafts, conflicts,
# failing or pending checks, and PRs whose base is not the default branch
# (stacked PRs: merge the parent first). Squash-merges and deletes the branch.
set -euo pipefail

usage="usage: pr-merge.sh <owner/repo> <pr-number> [--dry-run]"
(( $# == 2 || $# == 3 )) || { print -u2 $usage; exit 2 }
[[ $# == 2 || $3 == --dry-run ]] || { print -u2 $usage; exit 2 }
repo=$1 num=$2 dry=${3:-} title=
[[ $num == <-> ]] || { print -u2 "PR number must be numeric"; exit 2 }

fail() { print "NOT MERGED: $repo#$num${title:+ ($title)}: $1"; exit 1 }
gherr() { fail "$1: ${${2%%$'\n'*}:-gh failed}" }

if [[ $repo != */* ]]; then
  login=$(gh api user -q .login 2>&1) || gherr "could not read your gh login" "$login"
  repo=$login/$repo
fi
info=$(gh pr view $num -R $repo --json state,isDraft,mergeable,baseRefName,title,url,headRefOid,statusCheckRollup 2>&1) \
  || gherr "could not read the PR" "$info"
state=$(jq -r .state <<<$info); draft=$(jq -r .isDraft <<<$info)
mergeable=$(jq -r .mergeable <<<$info); base=$(jq -r .baseRefName <<<$info)
title=$(jq -r .title <<<$info); url=$(jq -r .url <<<$info); head=$(jq -r .headRefOid <<<$info)
default=$(gh repo view $repo --json defaultBranchRef -q .defaultBranchRef.name 2>&1) \
  || gherr "could not read the default branch" "$default"

[[ $state == OPEN ]]         || fail "state is $state"
[[ $draft == false ]]        || fail "it is a draft"
[[ $base == $default ]]      || fail "base is '$base', not '$default' (stacked PR; merge its parent first)"
[[ $mergeable != CONFLICTING ]] || fail "it has merge conflicts"

checks=$(jq -r '[.statusCheckRollup[] |
  if .__typename == "StatusContext" then
    (if .state == "SUCCESS" then "pass" elif .state == "PENDING" or .state == "EXPECTED" then "pending" else "fail" end)
  elif .status != "COMPLETED" then "pending"
  elif .conclusion == "SUCCESS" or .conclusion == "NEUTRAL" or .conclusion == "SKIPPED" then "pass"
  else "fail" end] | group_by(.) | map("\(.[0])=\(length)") | join(" ")' <<<$info)
[[ $checks == *fail=* ]] && fail "checks failing ($checks)"
[[ $checks == *pending=* ]] && fail "checks still running ($checks)"

if [[ $dry == --dry-run ]]; then
  print "WOULD MERGE: $repo#$num ($title) into $base at ${head[1,7]}, checks: ${checks:-none}"; exit 0
fi
out=$(gh pr merge $num -R $repo --squash --delete-branch --match-head-commit $head 2>&1) \
  || gherr "merge refused" "$out"
print "MERGED: $repo#$num ($title) into $base. $url"
