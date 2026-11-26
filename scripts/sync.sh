#!/bin/zsh
# Syncs the profile repo (commit, pull, push) and pulls the framework.
# Run by launchd every SYNC_INTERVAL seconds and at login.
#   sync.sh          full sync
#   sync.sh --pull   pull both, no commit or push (the SessionStart hook)
# The framework is pull-only unless FRAMEWORK_PUSH=1, which commits tracked changes only (never new files).
# When a pull changes it, install.sh re-renders CLAUDE.md, settings.json and the links (modules and
# launchd are left alone).
# On the LOCAL_BRANCH it runs scripts/upstream.sh sync instead (upstream + your open PRs).
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
sync_root=${0:A:h:h}
source $sync_root/lib/env.sh
mode=${1:-full}
[[ $mode == full ]] && echo "--- $(date '+%Y-%m-%d %H:%M:%S')"

has_upstream() { git -C $1 rev-parse -q --verify '@{u}' >/dev/null 2>&1 }
has_origin() { git -C $1 remote get-url origin >/dev/null 2>&1 }

# commit_all <repo> [-u]: commit every change with a "Sync <host> <time>" message.
# With -u only tracked files are staged, so new local files are never committed.
commit_all() {
  git -C $1 add ${2:--A}
  git -C $1 diff --cached --quiet && return 0
  git -C $1 commit -q -m "Sync $(hostname -s) $(date '+%Y-%m-%d %H:%M')" || { echo "commit failed in $1"; return 1 }
}

# alert <text>: tell the operator (tg-notify routes it to the master session's alert log when one runs).
# SYNC_ALERT_LOG (tests) appends the text to that file instead.
alert() {
  [[ -n $SYNC_ALERT_LOG ]] && { print -r -- "$1" >> $SYNC_ALERT_LOG; return 0 }
  /usr/bin/python3 $sync_root/modules/cron/tg-notify.py "$1" >/dev/null 2>&1 || true
}

# with_lock <repo> <cmd...>: runs cmd while holding the repo's sync lock (a directory in its .git), so
# syncs started together (SessionStart in many sessions plus the scheduled one) never race on fetch or
# rebase. A sync that cannot get the lock within SYNC_LOCK_WAIT seconds (default 30, 5 for --pull,
# which runs under the SessionStart hook's 15 s timeout) skips quietly:
# the one holding it is doing the same work, and the next run catches up. A lock whose owner is gone,
# or older than SYNC_LOCK_STALE seconds (default 600), is taken over by an atomic rename, and a
# sync only releases a lock that still holds its own pid.
with_lock() {
  local repo=$1; shift
  local lock=$(git -C $repo rev-parse --path-format=absolute --git-path harness-sync.lock 2>/dev/null)
  [[ -n $lock ]] || { "$@"; return }
  local waited=0 pid old moved lock_wait=${SYNC_LOCK_WAIT:-30}
  [[ $mode == full ]] || lock_wait=${SYNC_LOCK_WAIT:-5}
  until mkdir $lock 2>/dev/null; do
    pid=$(<$lock/pid 2>/dev/null)
    old=( $lock(N/mm+$(( ${SYNC_LOCK_STALE:-600} / 60 ))) )
    if [[ -n $pid ]] && ! kill -0 $pid 2>/dev/null || (( $#old )); then
      if mv $lock $lock.stale.$$ 2>/dev/null; then
        moved=$(<$lock.stale.$$/pid 2>/dev/null)
        if [[ $moved != $pid ]] && mkdir $lock 2>/dev/null; then
          print -r -- $moved > $lock/pid
        fi
        rm -rf $lock.stale.$$
      fi
      continue
    fi
    if (( waited >= lock_wait * 5 )); then
      echo "another sync holds ${repo:t}; skipping (the next run catches up)"
      return 0
    fi
    sleep 0.2; (( waited++ ))
  done
  print -r -- $$ > $lock/pid
  { "$@" } always { [[ $(<$lock/pid 2>/dev/null) == $$ ]] && rm -rf $lock }
}

# rebasing <repo>: true while a rebase is stopped half-way (conflict, or an edit stop).
rebasing() { [[ -d $(git -C $1 rev-parse --path-format=absolute --git-path rebase-merge 2>/dev/null) || -d $(git -C $1 rev-parse --path-format=absolute --git-path rebase-apply 2>/dev/null) ]] }

# recover_interrupted <repo>: git rebase --autostash writes rebase-merge/autostash before head-name, so a
# sync killed between the two (the SessionStart hook's timeout) leaves a rebase that --continue and
# --abort cannot read. Quit it (git then keeps the autostash as stash@{0}) and pop that entry back, but
# only when the stash was taken on the current HEAD, so the pop is a clean restore and never a merge.
recover_interrupted() {
  local dir=$(git -C $1 rev-parse --path-format=absolute --git-path rebase-merge 2>/dev/null)
  [[ -f $dir/autostash && ! -e $dir/head-name ]] || return 0
  git -C $1 symbolic-ref -q HEAD >/dev/null || return 0
  local sha=$(<$dir/autostash)
  git -C $1 rebase --quit >/dev/null 2>&1 || return 0
  echo "quit an interrupted rebase in $1 (it held only the autostash)"
  if [[ $(git -C $1 rev-parse -q --verify 'stash@{0}') == $sha &&
        $(git -C $1 rev-parse -q --verify "$sha^1") == $(git -C $1 rev-parse HEAD) ]] &&
     git -C $1 stash pop -q 'stash@{0}' >/dev/null 2>&1; then
    echo "restored its autostash"
    return 0
  fi
  echo "could not restore the autostash $sha in $1; it is kept in git stash"
  alert "Sync: quit an interrupted rebase in ${1:t} on $(hostname -s), but its local changes could not be restored by themselves; they are safe in git stash there (autostash $sha), run git stash pop."
  return 1
}

# pull_rebase <repo>: fetch the upstream branch, then rebase onto its remote-tracking ref (never
# FETCH_HEAD, which concurrent fetches overwrite: "Cannot rebase onto multiple branches"). A failed
# rebase is aborted, so the branch stays checked out and later syncs never pile commits onto a detached
# HEAD that is never pushed; the operator gets an alert that says which step failed.
pull_rebase() {
  local b=$(git -C $1 branch --show-current)
  local remote=$(git -C $1 config branch.$b.remote) merge=$(git -C $1 config branch.$b.merge)
  if [[ -z $remote || -z $merge || $remote == . ]]; then
    git -C $1 pull --rebase --autostash -q && return 0
    echo "pull failed in $1"
    alert "Sync: pull failed in ${1:t} on $(hostname -s); it retries on the next sync."
    return 1
  fi
  if ! git -C $1 fetch -q $remote ${merge#refs/heads/}; then
    echo "fetch from $remote failed in $1 (network or remote?)"
    alert "Sync: fetch from $remote failed in ${1:t} on $(hostname -s) (network or remote?); it retries on the next sync."
    return 1
  fi
  if [[ $mode != full ]] && (( SECONDS > ${SYNC_PULL_BUDGET:-8} )); then
    # Under the SessionStart hook a late rebase can be killed half-way; the next sync does it.
    echo "pull ran ${SECONDS}s; not starting a rebase this close to the hook timeout"
    return 0
  fi
  git -C $1 rebase --autostash -q '@{u}' && return 0
  if rebasing $1; then
    git -C $1 rebase --abort 2>/dev/null
    echo "rebase onto $remote/${merge#refs/heads/} hit a conflict in $1; rebase aborted, resolve manually"
    alert "Sync: rebase onto $remote/${merge#refs/heads/} hit a conflict in ${1:t} on $(hostname -s); rebase aborted, local commits are not pushed until someone merges by hand."
  else
    echo "rebase onto $remote/${merge#refs/heads/} failed in $1 (local changes in the way?)"
    alert "Sync: rebase onto $remote/${merge#refs/heads/} failed in ${1:t} on $(hostname -s) (local changes in the way?); it retries on the next sync."
  fi
  return 1
}

# push_pull <repo>: pull (rebase) and push; first push sets the upstream.
push_pull() {
  has_origin $1 || { echo "no remote for $1; committed locally only"; return 0 }
  if has_upstream $1; then
    pull_rebase $1 || return 1
    git -C $1 push -q || echo "push failed in $1"
  else
    git -C $1 push -q -u origin HEAD || echo "first push failed in $1"
  fi
}

# sync_profile: the profile part, run under the profile's lock (a sync mid-rebase is not "stuck").
sync_profile() {
  recover_interrupted $PROFILE_DIR || return 1
  if rebasing $PROFILE_DIR; then
    # Left over from an interrupted sync: committing now would land on a detached HEAD.
    echo "profile $PROFILE_DIR is mid-rebase; not syncing until it is resolved"
    alert "Sync: ${PROFILE_DIR:t} on $(hostname -s) is stuck mid-rebase; nothing is pushed until it is resolved (git status there)."
    return 1
  elif [[ $mode == full ]]; then
    commit_all $PROFILE_DIR && push_pull $PROFILE_DIR
  elif has_upstream $PROFILE_DIR; then
    pull_rebase $PROFILE_DIR
  fi
}

# pull_framework: fast-forward the framework to its upstream (fetch, then merge the tracking ref).
pull_framework() {
  git -C $HARNESS_DIR fetch -q && git -C $HARNESS_DIR merge --ff-only -q '@{u}' >/dev/null
}

push_framework() { commit_all $HARNESS_DIR -u && push_pull $HARNESS_DIR }

rc=0
if [[ -d $PROFILE_DIR/.git ]]; then
  with_lock $PROFILE_DIR sync_profile || rc=1
else
  echo "profile $PROFILE_DIR is not a git repo; run install.sh"
  rc=1
fi

if [[ -d $HARNESS_DIR/.git && $(git -C $HARNESS_DIR branch --show-current) == $LOCAL_BRANCH ]]; then
  # Contributor setup (CONTRIBUTING.md): upstream plus your open PRs. Only on full syncs: it calls GitHub.
  [[ $mode == full ]] && { $HARNESS_DIR/scripts/upstream.sh sync || rc=1 }
elif [[ -d $HARNESS_DIR/.git ]] && has_upstream $HARNESS_DIR; then
  before=$(git -C $HARNESS_DIR rev-parse HEAD)
  if [[ $mode == full && $FRAMEWORK_PUSH == 1 ]]; then
    with_lock $HARNESS_DIR push_framework || rc=1
  else
    with_lock $HARNESS_DIR pull_framework || { echo "framework pull failed (local changes? set FRAMEWORK_PUSH=1 or resolve)"; rc=1 }
  fi
  if [[ $(git -C $HARNESS_DIR rev-parse HEAD) != $before ]]; then
    echo "framework updated; re-rendering"
    HARNESS_SKIP_LAUNCHD=1 $HARNESS_DIR/install.sh --yes --no-modules >/dev/null || echo "install.sh failed; run it by hand"
  fi
fi

[[ $mode == full ]] && { (( rc )) && echo "done with errors" || echo "ok" }
exit $rc
