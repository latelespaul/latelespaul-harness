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
source ${0:A:h:h}/lib/env.sh
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

# push_pull <repo>: pull (rebase) and push; first push sets the upstream.
push_pull() {
  has_origin $1 || { echo "no remote for $1; committed locally only"; return 0 }
  if has_upstream $1; then
    git -C $1 pull --rebase --autostash -q || { echo "pull failed in $1; resolve manually"; return 1 }
    git -C $1 push -q || echo "push failed in $1"
  else
    git -C $1 push -q -u origin HEAD || echo "first push failed in $1"
  fi
}

rc=0
if [[ -d $PROFILE_DIR/.git ]]; then
  if [[ $mode == full ]]; then
    commit_all $PROFILE_DIR && push_pull $PROFILE_DIR || rc=1
  elif has_upstream $PROFILE_DIR; then
    git -C $PROFILE_DIR pull --rebase --autostash -q || rc=1
  fi
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
    commit_all $HARNESS_DIR -u && push_pull $HARNESS_DIR || rc=1
  else
    git -C $HARNESS_DIR pull --ff-only -q || { echo "framework pull failed (local changes? set FRAMEWORK_PUSH=1 or resolve)"; rc=1 }
  fi
  if [[ $(git -C $HARNESS_DIR rev-parse HEAD) != $before ]]; then
    echo "framework updated; re-rendering"
    HARNESS_SKIP_LAUNCHD=1 $HARNESS_DIR/install.sh --yes --no-modules >/dev/null || echo "install.sh failed; run it by hand"
  fi
fi

[[ $mode == full ]] && { (( rc )) && echo "done with errors" || echo "ok" }
exit $rc
