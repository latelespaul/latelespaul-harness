#!/bin/zsh
# Installs the harness for this user: profile, ~/.claude links and rendered files, sync agent, modules.
# Safe to re-run; anything it replaces is moved to ~/.claude/backups/harness-<time>/ first.
#   install.sh                       install (asks for harness.env values on first run)
#   install.sh KEY=VALUE ...         set those harness.env values, then install
#   install.sh --yes                 never ask; take values from KEY=VALUE, the environment, or defaults
#   install.sh --env-only            only write harness.env
#   install.sh --no-modules          skip the module installers
#   install.sh --dry-run             print what it would do, change nothing
# HARNESS_SKIP_LAUNCHD=1 writes the plists but never calls launchctl.
set -e
setopt extended_glob
here=${0:A:h}
keys=(PROJECTS_DIR PROFILE_DIR PROFILE_REMOTE GH_USER LABEL_PREFIX MODULES MEMORY_DIRS SYNC_INTERVAL
  FRAMEWORK_PUSH BROWSER_PORT BROWSER_EXTRA TELEGRAM_WORKDIR TELEGRAM_BRIEF_TIME
  FIRSTMATE_REPO FIRSTMATE_UPSTREAM FIRSTMATE_DIR FIRSTMATE_SESSION FIRSTMATE_TELEGRAM)
typeset -A vals
yes=0 env_only=0 no_modules=0
for a in "$@"; do
  case $a in
    --dry-run) export HARNESS_DRY_RUN=1 ;;
    --yes) yes=1 ;;
    --env-only) env_only=1 ;;
    --no-modules) no_modules=1 ;;
    -h|--help) sed -n '2,10p' $0 | cut -c3-; exit 0 ;;
    [A-Z_]##=*)
      (( ${keys[(Ie)${a%%=*}]} )) || { print -u2 "unknown key: ${a%%=*}"; exit 1 }
      vals[${a%%=*}]=${a#*=} ;;
    *) print -u2 "unknown argument: $a (see --help)"; exit 1 ;;
  esac
done
[[ -t 0 ]] || yes=1

# --- harness.env ---------------------------------------------------------------------------
env_file=$here/harness.env

# write_env <base-file>: harness.env = base with the keys in $vals replaced (or appended).
write_env() {
  local line k out=()
  typeset -A seen
  for line in "${(@f)$(<$1)}"; do
    k=${line%%=*}
    if [[ $line == [A-Z_]##=* ]] && (( ${+vals[$k]} )); then
      out+=("$k=${(qq)vals[$k]}"); seen[$k]=1
    else
      out+=("$line")
    fi
  done
  for k in ${(k)vals}; do
    if (( ! ${+seen[$k]} )); then out+=("$k=${(qq)vals[$k]}"); fi
  done
  if [[ $HARNESS_DRY_RUN == 1 ]]; then
    export HARNESS_ENV=$(mktemp -t harness-env)
    print -l -- $out > $HARNESS_ENV
    print "would write $env_file:"; grep -E '^[A-Z_]+=' $HARNESS_ENV | sed 's/^/  /'
  else
    print -l -- $out > $env_file
    print "wrote $env_file"
  fi
}

# ask <KEY> <question> <default>: fill vals[KEY] from the argument, environment, a prompt, or the default.
ask() {
  local k=$1 q=$2 def=$3 v
  (( ${+vals[$k]} )) && return 0
  if [[ -n ${(P)k} ]]; then vals[$k]=${(P)k}; return 0; fi
  if (( yes )); then
    [[ -n $def ]] && vals[$k]=$def
    return 0
  fi
  read "v?$q [${def:-none}]: "
  vals[$k]=${v:-$def}
}

if [[ ! -f $env_file ]]; then
  print "No harness.env yet; creating it."
  def_user=$(gh api user -q .login 2>/dev/null || true)
  ask GH_USER "GitHub handle" "$def_user"
  ask PROJECTS_DIR "Projects folder" "$HOME/Projects"
  ask PROFILE_DIR "Profile folder (private)" "${vals[PROJECTS_DIR]:-$HOME/Projects}/agent-profile"
  ask PROFILE_REMOTE "Profile GitHub repo URL (empty = local only)" ""
  ask LABEL_PREFIX "launchd label prefix" "${${(L)${vals[GH_USER]:-$USER}}//[^a-z0-9-]/}"
  ask MODULES "Modules (telegram browser firstmate hammerspoon cron eyeshands)" ""
  for k in $keys; do
    if [[ -z ${vals[$k]} && -n ${(P)k} ]]; then vals[$k]=${(P)k}; fi
  done
  write_env $here/harness.env.example
elif (( ${#vals} )); then
  write_env $env_file
fi
(( env_only )) && exit 0

source $here/lib/common.sh
mods=(${(z)MODULES})
for m in $mods; do
  [[ -x $HARNESS_DIR/modules/$m/install.sh ]] || { print -u2 "unknown module in MODULES: $m"; exit 1 }
done
print "harness: $HARNESS_DIR"
print "profile: $PROFILE_DIR"
print "modules: ${MODULES:-none}"
dry && print "(dry run: nothing is changed)"

for c in git jq; do command -v $c >/dev/null || { print -u2 "$c is required: brew install $c"; exit 1 }; done
for c in gh claude python3; do command -v $c >/dev/null || print "note: $c not found; see SETUP.md step 1"; done

# --- profile -------------------------------------------------------------------------------
if [[ ! -d $PROFILE_DIR ]]; then
  if [[ -n $PROFILE_REMOTE ]]; then
    act git clone -q $PROFILE_REMOTE $PROFILE_DIR
  else
    act mkdir -p $PROFILE_DIR
  fi
fi
if [[ ! -f $PROFILE_DIR/ABOUT.md ]]; then
  # A new (or empty, freshly cloned) profile: start it from the template. Never overwrites files.
  act cp -Rn $HARNESS_DIR/profile.example/. $PROFILE_DIR/ || true
  dry || print "copied profile.example into $PROFILE_DIR"
fi
for d in memory knowledge/sessions skills; do [[ -d $PROFILE_DIR/$d ]] || act mkdir -p $PROFILE_DIR/$d; done
[[ -f $PROFILE_DIR/memory/MEMORY.md ]] || act cp $HARNESS_DIR/profile.example/memory/MEMORY.md $PROFILE_DIR/memory/
if [[ ! -d $PROFILE_DIR/.git ]]; then
  act git -C $PROFILE_DIR init -q -b main
fi
if [[ -n $PROFILE_REMOTE ]] && ! git -C $PROFILE_DIR remote get-url origin >/dev/null 2>&1; then
  act git -C $PROFILE_DIR remote add origin $PROFILE_REMOTE
fi
act git -C $PROFILE_DIR config core.hooksPath $HARNESS_DIR/.githooks
if ! git -C $PROFILE_DIR rev-parse -q --verify HEAD >/dev/null 2>&1; then
  act git -C $PROFILE_DIR add -A
  act git -C $PROFILE_DIR commit -q -m "Start profile" || print "note: first profile commit failed (is git user.name/email set?)"
fi

# --- framework -----------------------------------------------------------------------------
[[ -d $HARNESS_DIR/.git ]] && act git -C $HARNESS_DIR config core.hooksPath .githooks
act mkdir -p $HARNESS_DIR/logs
# Only scripts that start with a shebang get +x, so files git tracks as 100644 (tests, templates)
# keep their mode and git status stays clean. (A loop, not a glob qualifier: set -e exits on its false.)
exe=($HARNESS_DIR/install.sh $HARNESS_DIR/.githooks/*(.))
for f in $HARNESS_DIR/{scripts,modules/*}/*.(sh|py|mjs)(N.); do
  [[ $(head -c2 -- $f) == '#!' ]] && exe+=($f)
done
act chmod +x $exe

# --- ~/.claude -----------------------------------------------------------------------------
ensure_dir $claude_dir
for d in skills commands agents projects; do ensure_dir $claude_dir/$d; done

# CLAUDE.md: the template plus a note per enabled module.
notes=()
for m in $mods; do
  [[ -f $HARNESS_DIR/modules/$m/claude-notes.md.tmpl ]] && notes+=("$(render $HARNESS_DIR/modules/$m/claude-notes.md.tmpl)")
done
MODULE_NOTES=${(F)notes:-"- None enabled (core only). Add them with MODULES in harness.env."}
render_keys+=(MODULE_NOTES)
write_file $claude_dir/CLAUDE.md "$(render $HARNESS_DIR/templates/claude.md.tmpl)"

# settings.json = what is there now, with the harness's own hooks replaced by
# template + enabled modules' fragments + the profile's settings.json (later ones win).
tmp=$(mktemp -d)
parts=($tmp/0.json)
render $HARNESS_DIR/templates/settings.json.tmpl > $tmp/0.json
for m in $mods; do
  if [[ -f $HARNESS_DIR/modules/$m/settings.json.tmpl ]]; then
    render $HARNESS_DIR/modules/$m/settings.json.tmpl > $tmp/$m.json; parts+=$tmp/$m.json
  fi
  if [[ -f $HARNESS_DIR/modules/$m/settings.zsh ]]; then
    zsh $HARNESS_DIR/modules/$m/settings.zsh > $tmp/$m-extra.json; parts+=$tmp/$m-extra.json
  fi
done
[[ -f $PROFILE_DIR/settings.json ]] && parts+=$PROFILE_DIR/settings.json
for p in $parts; do jq empty $p 2>/dev/null || { print -u2 "invalid JSON: $p"; exit 1 }; done
existing='{}'
if [[ -e $claude_dir/settings.json ]]; then
  existing=$(jq . $claude_dir/settings.json 2>/dev/null) || { print "note: ~/.claude/settings.json is not valid JSON; it will be backed up"; existing='{}' }
fi
merge='
  def m($a; $b):
    if ($a|type) == "object" and ($b|type) == "object" then
      reduce ($b|keys_unsorted[]) as $k ($a; .[$k] = m($a[$k]; $b[$k]))
    elif ($a|type) == "array" and ($b|type) == "array" then
      reduce $b[] as $x ($a; if any(.[]; . == $x) then . else . + [$x] end)
    elif $b == null then $a else $b end;
  def ours: tostring as $s | any($own[]; . as $o | $s | contains($o));
  (reduce $ARGS.positional[] as $p ({}; m(.; $p))) as $g
  | ($e | if .hooks then .hooks |= map_values(map(select(ours | not))) else . end) as $e2
  | m($e2; $g)
  | if .hooks then .hooks |= with_entries(select(.value | length > 0)) else . end'
own=$(jq -n --arg h $HARNESS_DIR --arg p $PROFILE_DIR --arg ht "${HARNESS_DIR/#$HOME/~}" --arg pt "${PROFILE_DIR/#$HOME/~}" '[$h, $p, $ht, $pt]')
settings=$(jq -n --argjson e "$existing" --argjson own "$own" "$merge" \
  --jsonargs ${(f)"$(for p in $parts; do jq -c . $p; done)"})
rm -rf $tmp
write_file $claude_dir/settings.json "$settings"

# Skills, commands, subagents: framework first, the profile's own win on name clashes.
# Skills are linked one by one: ~/.claude/skills also holds skills Claude manages itself.
typeset -A pick
for s in $HARNESS_DIR/skills/*(N/) $PROFILE_DIR/skills/*(N/); do pick[skills/${s:t}]=$s; done
for f in $HARNESS_DIR/{commands,agents}/*.md(N) $PROFILE_DIR/{commands,agents}/*.md(N); do
  pick[${f:h:t}/${f:t}]=$f
done
# A module that renders its own skill (modules/<name>/skill/) owns that skill name.
for m in $mods; do [[ -d $HARNESS_DIR/modules/$m/skill ]] && unset "pick[skills/$m]"; done
for k in ${(ko)pick}; do link $pick[$k] $claude_dir/$k; done
# Links into the harness or profile whose target is gone (a removed skill) are cleaned up.
for l in $claude_dir/{skills,commands,agents}/*(N@); do
  t=$(readlink $l)
  if [[ ! -e $l && ( $t == $HARNESS_DIR/* || $t == $PROFILE_DIR/* ) ]]; then
    act rm $l; dry || print "removed stale link $l"
  fi
done

# Claude Code keeps auto-memory per working folder; point the main ones at the profile.
for d in ${(z)MEMORY_DIRS}; do link_memory $d; done

# --- sync agent ----------------------------------------------------------------------------
label=com.$LABEL_PREFIX.harness-sync
plist=$agents_dir/$label.plist
ensure_dir $agents_dir
write_file $plist "$(render $HARNESS_DIR/templates/launchd/harness-sync.plist.tmpl)"
if (( changed )) || ! launchd_loaded $label; then
  launchd_load $label $plist
  print "sync agent $label: every $SYNC_INTERVAL s and at login; log: $HARNESS_DIR/logs/sync.log"
fi

# --- modules -------------------------------------------------------------------------------
failed=()
if (( ! no_modules )); then
  for m in $mods; do
    print "\n== module $m"
    $HARNESS_DIR/modules/$m/install.sh || failed+=$m
  done
fi

print
[[ -d $HARNESS_BACKUP ]] && print "backups: $HARNESS_BACKUP"
if (( ${#failed} )); then
  print "Core installed. Modules that need attention: $failed (see their SETUP.md)."
  exit 2
fi
print "Done. Check it with: $HARNESS_DIR/scripts/check.sh"
