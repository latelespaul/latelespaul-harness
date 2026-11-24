#!/bin/zsh
# The harness retro: the weekly review that turns how we work into harness and profile changes.
# It collects what the profile captured since the last run (session entries, learnings, changed
# memories) and the rule lint, then runs a headless Claude session on commands/retro.md, which sorts
# each item into PERSONAL / GENERAL / STALE and acts on it. See docs/retro.md.
#   retro.sh               collect, run the review, write the summary, move the marker
#   retro.sh --collect     collect only; print the input file's path (the /retro command uses this)
#   retro.sh --since DATE  review from DATE ("YYYY-MM-DD" or "YYYY-MM-DD HH:MM"), not the marker
# HARNESS_DRY_RUN=1 acts like --collect. Schedule it with hcron (docs/retro.md).
source ${0:A:h:h}/lib/env.sh
path+=($HOME/.local/bin /opt/homebrew/bin /usr/local/bin)
state=$PROFILE_DIR/knowledge/retro marker=$PROFILE_DIR/knowledge/retro/last-run
work=${RETRO_WORK:-$HARNESS_DIR/logs/retro}   # inputs, summaries, log, lock
kb=$PROFILE_DIR/knowledge
die() { print -r -- "retro.sh: $*" >&2; exit 1 }

collect_only=0 since=
while (( $# )); do
  case $1 in
    --collect) collect_only=1 ;;
    --since) since=$2; shift ;;
    *) die "unknown option: $1" ;;
  esac; shift
done
[[ $HARNESS_DRY_RUN == 1 ]] && collect_only=1
[[ -d $kb ]] || die "no knowledge folder in the profile: $kb"
mkdir -p $state $work
[[ -z $since && -f $marker ]] && since=$(<$marker)
: ${since:=1970-01-02 00:00}   # not 01-01: east of UTC that is before the epoch and BSD find rejects it
day=${since[1,10]}
now=$(date '+%Y-%m-%d %H:%M') stamp=$(date +%Y-%m-%d)
input=$work/$stamp-input.md

# Session entries whose "## YYYY-MM-DD HH:MM" heading is at or after $since.
sessions() {
  local f
  for f in $kb/sessions/*.md(N); do
    awk -v s="$since" '/^## [0-9]{4}-[0-9]{2}-[0-9]{2}/ { on = (substr($0, 4, 16) >= s) } on' $f
  done
}
# Learnings dated on or after $day: bullets tagged _(YYYY-MM-DD)_, and "## Topic (YYYY-MM-DD)" sections.
learnings() {
  [[ -f $kb/learnings.md ]] || return 0
  awk -v d="$day" '
    /^## / { sec = 0; if (match($0, /\([0-9]{4}-[0-9]{2}-[0-9]{2}\)/)) sec = (substr($0, RSTART + 1, 10) >= d) }
    sec { print; next }
    match($0, /_\([0-9]{4}-[0-9]{2}-[0-9]{2}\)_/) && substr($0, RSTART + 2, 10) >= d { print }
  ' $kb/learnings.md
}
# Memory files changed since $since (all of them on the first run).
memories() {
  local m
  for m in ${(f)"$(find $PROFILE_DIR/memory -name '*.md' ! -name MEMORY.md -newermt "$since" | sort)"}; do
    print -r -- "### ${m:t}"; cat $m; print
  done
}

{
  print "# Retro input $now (since $since)\n"
  print "Profile: $PROFILE_DIR · Harness: $HARNESS_DIR\n"
  print "## New session entries\n"; sessions; print
  print "## New learnings\n"; learnings; print
  print "## Changed memories\n"; memories; print
  print "## Rule lint (scripts/rule-lint.mjs --profile)\n"
  print '```'; node $HARNESS_DIR/scripts/rule-lint.mjs --harness $HARNESS_DIR --profile $PROFILE_DIR; print '```'
} > $input
print -r -- $input
(( collect_only )) && exit 0

command -v claude >/dev/null || die "claude is not on PATH"
lock=$work/lock
if ! mkdir $lock 2>/dev/null; then
  pid=$(cat $lock/pid 2>/dev/null)
  [[ -n $pid ]] && kill -0 $pid 2>/dev/null && die "another retro is running (pid $pid)"
  rm -rf $lock; mkdir $lock || die "cannot take the lock $lock"
fi
print $$ > $lock/pid
trap 'rm -rf $lock' EXIT
export HARNESS_LEARN=1   # the review's own session must not feed session-learn.sh
[[ $CLAUDE_P_IGNORE_API_KEY == 1 ]] && unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN

summary=$work/$stamp-summary.txt; rm -f $summary
allowed=(Read Write Edit Glob Grep "Bash(no-mistakes:*)" "Bash(gh pr list:*)" "Bash(gh pr view:*)"
  "Bash(node $HARNESS_DIR/scripts/rule-lint.mjs:*)" "Bash(node scripts/rule-lint.mjs:*)"
  "Bash($HARNESS_DIR/scripts/upstream.sh:*)" "Bash(scripts/upstream.sh:*)" "Bash(ls:*)" "Bash(cat:*)" "Bash(wc:*)"
  "Bash(diff:*)" "Bash(mkdir:*)" "Bash(grep:*)" "Bash(date:*)" "Bash(cd:*)")
for c in status diff log show add commit rm mv restore branch rev-parse; do allowed+=("Bash(git $c:*)"); done
(( RETRO_MERGE )) && allowed+=("Bash($HARNESS_DIR/scripts/pr-merge.sh:*)" "Bash(scripts/pr-merge.sh:*)" "Bash($HARNESS_DIR/install.sh:*)")
# upstream.sh new puts worktrees next to the main checkout, in <main checkout>-work/.
main_wt=$(git -C $HARNESS_DIR worktree list --porcelain 2>/dev/null | sed -n '1s/^worktree //p')
wt_root=${RETRO_WT_ROOT:-${main_wt:-$HARNESS_DIR}-work}; mkdir -p $wt_root
body=$(awk 'NR == 1 && /^---$/ { fm = 1; next } fm && /^---$/ { fm = 0; next } !fm' $HARNESS_DIR/commands/retro.md)
prompt="${body//\$ARGUMENTS/$input}

This is the scheduled headless run: nobody can answer questions. Merging is $( (( RETRO_MERGE )) && print allowed || print 'not allowed: open PRs only' ).
Write the summary (at most 3 lines) to $summary as your last step."

print "$(date '+%F %T') retro start (since $since)" >> $work/retro.log
# No timeout here: hcron's --timeout stops a run that hangs.
cd $HARNESS_DIR
print -r -- $prompt | claude -p --model $RETRO_MODEL --permission-mode acceptEdits --allowedTools $allowed \
  --add-dir $PROFILE_DIR $wt_root \
  --no-session-persistence >> $work/retro.log 2>&1
rc=$?
print "$(date '+%F %T') retro end rc=$rc" >> $work/retro.log
(( rc == 0 )) && [[ -s $summary ]] || {
  python3 $HARNESS_DIR/modules/cron/tg-notify.py "Harness retro failed (rc=$rc); see $work/retro.log" >/dev/null 2>&1
  exit 1
}
mkdir -p $PROFILE_DIR/logs && cp $summary $PROFILE_DIR/logs/retro-summary.txt
python3 $HARNESS_DIR/modules/cron/tg-notify.py "Harness retro: $(head -3 $summary)" >/dev/null 2>&1
print -r -- $now > $marker
