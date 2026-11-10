# Shared helpers for install.sh and the module installers.
# HARNESS_DRY_RUN=1 prints actions instead of doing them; HARNESS_SKIP_LAUNCHD=1 never calls launchctl.
source ${${(%):-%x}:A:h}/env.sh

claude_dir=$HOME/.claude
agents_dir=$HOME/Library/LaunchAgents
# One backup folder per install run, shared with the module installers it starts.
export HARNESS_BACKUP=${HARNESS_BACKUP:-$claude_dir/backups/harness-$(date +%Y%m%d-%H%M%S)}

dry() { [[ $HARNESS_DRY_RUN == 1 ]] }

# act <command...>: run it, or only print it on a dry run.
act() {
  if dry; then print -r -- "would: ${(j: :)${(q-)@}}"; else "$@"; fi
}

# backup <path>: move a file, folder or link into this run's backup folder.
backup() {
  local name=${${${1#$HOME/}#.}//\//__}   # ~/.claude/CLAUDE.md -> claude__CLAUDE.md
  if dry; then print -r -- "would back up $1 -> $HARNESS_BACKUP/$name"; return; fi
  mkdir -p $HARNESS_BACKUP
  mv $1 $HARNESS_BACKUP/$name
  print -r -- "backed up $1 -> $HARNESS_BACKUP/$name"
}

# link <source> <link-path>: back up whatever is there, then symlink.
link() {
  local src=$1 dst=$2
  [[ -L $dst && ${dst:A} == ${src:A} ]] && return 0
  [[ -e $dst || -L $dst ]] && backup $dst
  act ln -s $src $dst
  dry || print -r -- "linked $dst -> $src"
}

# ensure_dir <dir>: make sure it is a real folder (an old whole-folder symlink is backed up first).
ensure_dir() {
  [[ -L $1 ]] && backup $1
  [[ -d $1 ]] || act mkdir -p $1
}

# write_file <path> <content>: write it if the content changed, backing up the old file.
# Sets changed=1 when it wrote (or would write), else changed=0.
write_file() {
  local dst=$1 content=$2
  changed=0
  [[ -f $dst && ! -L $dst && "$(<$dst)" == "$content" ]] && return 0
  changed=1
  [[ -e $dst || -L $dst ]] && backup $dst
  if dry; then print -r -- "would write $dst"; return 0; fi
  mkdir -p ${dst:h}
  print -r -- "$content" > $dst
  print -r -- "wrote $dst"
}

# render <template>: print it with every __KEY__ (KEY in $render_keys) replaced by $KEY.
render() {
  setopt local_options extended_glob
  local s=$(<$1) k
  for k in $render_keys; do s=${s//__${k}__/${(P)k}}; done
  [[ $s == *__[A-Z][A-Z_]#__* ]] && print -u2 -r -- "warning: unfilled placeholder left in $1"
  print -r -- "$s"
}

# link_memory <working-folder>: point Claude Code's auto-memory for that folder at the profile.
# Memories already there are merged into the profile first (existing profile files win).
link_memory() {
  local dst=$claude_dir/projects/${1//[^A-Za-z0-9]/-}/memory mem=$PROFILE_DIR/memory f line
  if [[ -d $dst && ! -L $dst ]]; then
    for f in $dst/*.md(N); do
      if [[ ${f:t} != MEMORY.md && ! -e $mem/${f:t} ]]; then act cp $f $mem/; fi
    done
    if [[ -f $dst/MEMORY.md ]] && ! dry; then
      for line in "${(@f)$(<$dst/MEMORY.md)}"; do
        if [[ -n $line ]] && ! grep -qxF -- "$line" $mem/MEMORY.md 2>/dev/null; then
          print -r -- "$line" >> $mem/MEMORY.md
        fi
      done
    fi
    print -r -- "merged existing memories from $dst into $mem"
  fi
  ensure_dir ${dst:h}
  link $mem $dst
}

# launchd_load <label> <plist>: (re)load a LaunchAgent. Returns 1 if it is still not loaded.
# bootout returns while the old job's process may still be exiting, and launchd refuses a bootstrap
# of the same label until it is gone ("Bootstrap failed: 5: Input/output error"), which left the
# agent unloaded. So wait until launchd has let the old job go, and retry the bootstrap a few times.
launchd_load() {
  if [[ $HARNESS_SKIP_LAUNCHD == 1 ]]; then print -r -- "skipped loading $1 (HARNESS_SKIP_LAUNCHD=1)"; return 0; fi
  local target=gui/$(id -u) i
  if launchd_loaded $1; then act launchctl bootout $target/$1 2>/dev/null || true; fi
  if dry; then act launchctl bootstrap $target $2; return 0; fi
  for i in {1..60}; do launchd_loaded $1 || break; sleep 0.5; done
  for i in {1..3}; do
    launchctl bootstrap $target $2 2>/dev/null && return 0
    sleep 1
  done
  launchctl bootstrap $target $2   # last try, showing launchctl's own error
}

# launchd_unload <label>: stop a LaunchAgent if it is loaded.
launchd_unload() {
  [[ $HARNESS_SKIP_LAUNCHD == 1 ]] && return 0
  act launchctl bootout gui/$(id -u)/$1 2>/dev/null || true
}

# launchd_loaded <label>: is it loaded? (always false with HARNESS_SKIP_LAUNCHD=1)
launchd_loaded() {
  [[ $HARNESS_SKIP_LAUNCHD != 1 ]] && launchctl print gui/$(id -u)/$1 >/dev/null 2>&1
}

# enabled <module>: is it listed in MODULES?
enabled() { (( ${${(z)MODULES}[(Ie)$1]} )) }
