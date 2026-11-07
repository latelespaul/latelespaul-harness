#!/bin/zsh
# Two-way flow between this harness and the one it is shared with (see CONTRIBUTING.md).
#   upstream.sh status          what each side has that the other lacks, and open PRs both ways
#   upstream.sh sync [branch..] rebuild the running branch: upstream's default branch + your open PRs
#                               (+ the named branches, e.g. a PR GitHub does not list yet)
#   upstream.sh new <name>      start a change: a worktree on a new branch off upstream
#   upstream.sh pr [--title T] --body-file F
#                               run the checks, push the current branch, open (or update) its PR
# Remotes come from harness.env: UPSTREAM_REMOTE (the shared repo), FORK_REMOTE (your fork; may be
# absent if you own the upstream), LOCAL_BRANCH (the branch this checkout runs).
set -e
# A worktree has no harness.env of its own (it is gitignored); use the main checkout's.
main_wt=$(git -C ${0:A:h} worktree list --porcelain | sed -n '1s/^worktree //p')
export HARNESS_ENV=${HARNESS_ENV:-$main_wt/harness.env}
source ${0:A:h:h}/lib/common.sh
path+=(/opt/homebrew/bin /usr/local/bin)   # gh, when launchd runs us with a bare PATH
up=$UPSTREAM_REMOTE run=$LOCAL_BRANCH
fork=$FORK_REMOTE; git -C $main_wt remote get-url $fork >/dev/null 2>&1 || fork=$up
die() { print -r -- "upstream.sh: $*" >&2; exit 1 }
slug() { git -C $main_wt remote get-url $1 | sed -E 's#^(git@github\.com:|https://github\.com/)##; s#\.git$##' }
command -v gh >/dev/null || die "needs the GitHub CLI: brew install gh && gh auth login"
repo=$(slug $up)
git -C $main_wt fetch -q --prune $up
[[ $fork != $up ]] && git -C $main_wt fetch -q --prune $fork
base=$(git -C $main_wt symbolic-ref -q --short refs/remotes/$up/HEAD || print $up/main)
me=$(gh api user --jq .login)
my_prs() { gh pr list --repo $repo --author @me --state open --json headRefName --jq '.[].headRefName' }
# The newest copy of a PR branch: the local one if it has everything the pushed one has.
tip() {
  local r=refs/remotes/$fork/$1
  if git -C $main_wt rev-parse -q --verify refs/heads/$1 >/dev/null &&
     { ! git -C $main_wt rev-parse -q --verify $r >/dev/null || git -C $main_wt merge-base --is-ancestor $r refs/heads/$1 }
  then print refs/heads/$1; else print $r; fi
}
clean() { git -C $1 diff --quiet && git -C $1 diff --cached --quiet }

case ${1:-status} in
status)
  cd $main_wt
  print "upstream: $repo ($base) · this checkout runs: $(git branch --show-current)"
  n=$(git rev-list --count HEAD..$base); (( n )) && print "  $n upstream commit(s) not running here yet (upstream.sh sync)"
  print "your open PRs:"
  gh pr list --repo $repo --author @me --state open --json number,title,mergeable,reviewDecision \
    --jq '.[] | "  #\(.number) \(.title)  [\(.mergeable | ascii_downcase)\(if .reviewDecision != "" then ", " + (.reviewDecision | ascii_downcase) else "" end)]"'
  print "their open PRs (review these; merged ones reach you on the next sync):"
  gh pr list --repo $repo --state open --json number,title,author \
    --jq ".[] | select(.author.login != \"$me\") | \"  #\(.number) \(.title) (@\(.author.login))\""
  open=(${(f)"$(my_prs)"})
  for b in ${(f)"$(git for-each-ref --format='%(refname:short)' refs/heads)"}; do
    [[ $b == main || $b == $run || ${open[(Ie)$b]} -gt 0 ]] && continue
    n=$(git rev-list --count --no-merges $base..$b)
    (( n )) && print "  branch $b: $n commit(s) with no open PR (merged upstream, abandoned, or still to send)"
  done
  exit 0 ;;

sync)
  cd $main_wt
  clean . || die "uncommitted changes in $main_wt; commit them on a branch first"
  open=(${(f)"$(my_prs)"})
  for b in ${@:2}; do (( ${open[(Ie)$b]} )) || open+=$b; done
  tips=(); for b in $open; do tips+=$(tip $b); done
  if git rev-parse -q --verify refs/heads/$run >/dev/null; then
    # Commits made straight on the running branch would be lost by the rebuild: refuse instead.
    stray=$(git rev-list --no-merges --oneline $run --not $base ${tips[@]} | head -5)
    [[ -z $stray ]] || die "commits on '$run' that are in no open PR (move them to a branch and open a PR):
$stray"
    # Already has upstream and every PR tip: nothing to do.
    up_to_date=1
    for t in $base $tips; do git merge-base --is-ancestor $t $run || up_to_date=0; done
    (( up_to_date )) && [[ $(git branch --show-current) == $run ]] && { print "harness: up to date ($#open open PR(s) running)"; exit 0 }
  fi
  before=$(git rev-parse HEAD^{tree})
  git checkout -q -B $run $base
  for b in $open; do
    if git merge -q --no-edit -m "Run $b on $run" $(tip $b) >/dev/null 2>&1; then print "running PR branch $b"
    else git merge --abort; print "skipped $b: it conflicts with upstream now (rebase it: see CONTRIBUTING.md)"; fi
  done
  if [[ $(git rev-parse HEAD^{tree}) != $before ]]; then
    print "harness updated; re-rendering"
    HARNESS_SKIP_LAUNCHD=1 $main_wt/install.sh --yes --no-modules >/dev/null || print "install.sh failed; run it by hand"
  fi
  exit 0 ;;

new)
  [[ -n $2 ]] || die "usage: upstream.sh new <branch-name>"
  wt=${main_wt}-work/$2
  git -C $main_wt worktree add -q -b $2 $wt $base
  print -r -- "$wt"
  exit 0 ;;

pr)
  shift; title= body=
  while (( $# )); do case $1 in
    --title) title=$2; shift 2 ;; --body-file) body=$2; shift 2 ;; *) die "unknown option $1" ;; esac; done
  [[ -f $body ]] || die "write the PR description first (template: .github/pull_request_template.md), then pass --body-file"
  top=$(git rev-parse --show-toplevel); cd $top
  b=$(git branch --show-current)
  [[ -n $b && $b != main && $b != $run ]] || die "on '$b': start the change with 'upstream.sh new <name>'"
  clean . || die "uncommitted changes; commit them first"
  (( $(git rev-list --count $base..HEAD) )) || die "no commits on $b beyond $base"
  files=(${(f)"$(git diff --name-only --diff-filter=d $base...HEAD)"})
  bad=0
  for f in $files; do
    case $f in
      *.sh|*.zsh) zsh -n $f || { print "syntax error: $f"; bad=1 } ;;
      *.py) /usr/bin/python3 -m py_compile $f 2>/dev/null || { print "does not compile: $f"; bad=1 } ;;
    esac
  done
  # Personal values from harness.env and git must never reach the shared repo.
  added=$(git diff $base...HEAD | grep '^+' | grep -v '^+++' || true)
  for v in $HOME $USER $GH_USER $LABEL_PREFIX $PROFILE_REMOTE $(git config user.email) $(scutil --get LocalHostName 2>/dev/null); do
    (( ${#v} >= 4 )) || continue
    hits=$(print -r -- $added | grep -F -- $v || true)
    [[ -z $hits ]] || { print -r -- "personal value '$v' in the diff:"; print -r -- $hits | head -3; bad=1 }
  done
  HARNESS_DRY_RUN=1 HARNESS_SKIP_LAUNCHD=1 ./install.sh --yes >/dev/null 2>&1 || { print "install.sh --dry-run failed"; bad=1 }
  (( bad )) && die "checks failed; fix them and re-run"
  print "checks passed: syntax, no personal values, install.sh --dry-run"
  git push -q --force-with-lease -u $fork $b
  head=$b; [[ $fork != $up ]] && head=$me:$b
  url=$(gh pr list --repo $repo --head $b --state open --json url --jq '.[0].url')
  if [[ -n $url ]]; then
    gh pr edit $url --body-file $body >/dev/null
    print "updated $url"
  else
    [[ -n $title ]] || title=$(git log --reverse --format=%s $base..HEAD | head -1)
    gh pr create --repo $repo --base ${base#$up/} --head $head --title $title --body-file $body
  fi
  # Run the change here too, until upstream merges it.
  # (named explicitly: GitHub can take a few seconds to list a new PR)
  [[ $(git rev-parse --show-toplevel) == $main_wt ]] || $0 sync $b
  exit 0 ;;

*) sed -n '2,9p' $0; exit 1 ;;
esac
