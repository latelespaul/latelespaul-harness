#!/bin/zsh
# Checks that the harness is installed and healthy; prints PASS/FAIL/WARN per item.
# Exit 0 when nothing failed. Used by SETUP.md's verification step; safe anytime.
source ${0:A:h:h}/lib/common.sh
fails=0
pass() { print -r -- "PASS  $*" }
fail() { print -r -- "FAIL  $*"; (( fails++ )) }
warn() { print -r -- "WARN  $*" }
check() { local what=$1; shift; if "$@" >/dev/null 2>&1; then pass $what; else fail $what; fi }

check "harness.env exists" test -f $HARNESS_ENV
check "profile has ABOUT.md" test -f $PROFILE_DIR/ABOUT.md
check "profile has memory/MEMORY.md" test -f $PROFILE_DIR/memory/MEMORY.md
check "profile is a git repo" test -d $PROFILE_DIR/.git
if git -C $PROFILE_DIR remote get-url origin >/dev/null 2>&1; then
  if git -C $PROFILE_DIR rev-parse -q --verify '@{u}' >/dev/null 2>&1; then
    ahead=$(git -C $PROFILE_DIR rev-list --count '@{u}..HEAD')
    (( ahead == 0 )) && pass "profile pushed to $(git -C $PROFILE_DIR remote get-url origin)" \
      || warn "profile is $ahead commit(s) ahead of its remote (next sync pushes them)"
  else
    warn "profile not pushed yet (run scripts/sync.sh)"
  fi
else
  warn "profile has no remote: memory stays on this machine"
fi
grep -q '<[a-z][^>]*>' $PROFILE_DIR/ABOUT.md 2>/dev/null && warn "ABOUT.md still has <placeholders> to fill in"

check "~/.claude/CLAUDE.md imports AGENTS.md" grep -qF "@$HARNESS_DIR/AGENTS.md" $claude_dir/CLAUDE.md
check "~/.claude/CLAUDE.md imports ABOUT.md" grep -qF "@$PROFILE_DIR/ABOUT.md" $claude_dir/CLAUDE.md
check "~/.claude/settings.json is valid JSON" jq empty $claude_dir/settings.json
check "SessionEnd hook runs session-learn.sh" grep -qF "$HARNESS_DIR/scripts/session-learn.sh" $claude_dir/settings.json
for s in $HARNESS_DIR/skills/*(N/) $PROFILE_DIR/skills/*(N/); do
  check "skill ${s:t} linked" test -e $claude_dir/skills/${s:t}/SKILL.md
done
for f in $HARNESS_DIR/commands/*.md(N); do check "command /${f:t:r} linked" test -e $claude_dir/commands/${f:t}; done
if [[ -f $PROFILE_DIR/mcp.json ]]; then
  for name in ${(f)"$(jq -r '.mcpServers // {} | keys_unsorted[] | select(startswith("_") | not)' $PROFILE_DIR/mcp.json 2>/dev/null)"}; do
    if jq -e --arg n $name '.mcpServers[$n]' $HOME/.claude.json >/dev/null 2>&1; then pass "MCP server $name registered"
    else warn "MCP server $name from the profile's mcp.json is not registered (run install.sh)"; fi
  done
fi
for d in ${(z)MEMORY_DIRS}; do
  m=$claude_dir/projects/${d//[^A-Za-z0-9]/-}/memory
  check "auto-memory for ${d/#$HOME/~} -> profile" test "${m:A}" = "${PROFILE_DIR:A}/memory"
done
label=com.$LABEL_PREFIX.harness-sync
if [[ $HARNESS_SKIP_LAUNCHD == 1 ]]; then
  check "sync plist written" test -f $agents_dir/$label.plist
elif ! have_launchd; then
  if crontab -l 2>/dev/null | grep -q "scripts/sync\.sh"; then pass "sync.sh scheduled in crontab"
  else warn "no launchd here and no crontab line runs scripts/sync.sh (see install.sh's note)"; fi
else
  check "sync agent $label loaded" launchctl print gui/$(id -u)/$label
fi
for m in ${(z)MODULES}; do
  if $HARNESS_DIR/modules/$m/install.sh --status >/dev/null 2>&1; then pass "module $m"; else fail "module $m (run modules/$m/install.sh --status)"; fi
done

print
(( fails )) && { print "$fails check(s) failed."; exit 1 }
print "All checks passed."
