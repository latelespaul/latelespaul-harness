#!/bin/zsh
# Firstmate toolchain: the CLIs firstmate and its crew call (its bin/fm-bootstrap.sh checks the
# same list on session start, tmux backend). The firstmate installer runs this; it works alone too.
#   tools.sh            install what is missing or older than the pin below (never sudo)
#   tools.sh --status   list each tool as ok/old/MISSING with its version (exit 1 if a required one is not ok)
# npm and GitHub-release tools are pinned; brew tools get whatever Homebrew has (no pins there).
# Pins are what the harness was tested with; firstmate's own floors are lower (bootstrap says if they rise).
set -e
(( ${argv[(Ie)--dry-run]} )) && { export HARNESS_DRY_RUN=1; argv=(${argv:#--dry-run}) }
source ${0:A:h:h:h}/lib/common.sh
autoload -Uz is-at-least
self=${0:A} mode=${1:-install}
[[ $mode == (install|--status) ]] || { print "usage: $self [--status]"; exit 1 }

# name:how:pin:required. how = brew <formula> | npm | release | system | claude.
tools=(
  git:brew:-:1 tmux:brew:-:1 gh:brew:-:1 node:brew:-:1 jq:brew:-:1 curl:system:-:1
  gh-axi:npm:0.1.46:1 chrome-devtools-axi:npm:0.1.44:1 tasks-axi:npm:0.2.6:1 quota-axi:npm:0.1.69:1
  lavish-axi:npm:0.1.92:0
  treehouse:release:3.1.8:1 no-mistakes:release:1.84.0:1
  claude:claude:-:1
)
# Release tools: repo, binary folder, and the SHA-256 of each pinned macOS archive (from the
# release's checksums.txt), so a download is checked against a hash kept here, not one fetched with it.
typeset -A repo=(treehouse kunchenguid/treehouse no-mistakes kunchenguid/no-mistakes)
typeset -A bindir=(treehouse $HOME/.local/bin no-mistakes $HOME/.no-mistakes/bin)
typeset -A sha=(
  treehouse-arm64   007c55c26e0bd8b672b1a917465f06c3f89d93a66cd171364ffb65743d268601
  treehouse-amd64   6be7f71cc8c6a1fbf40311af8ee3c45459c72afbab2c93dc2f80a183427bcbeb
  no-mistakes-arm64 2e5f838303ab727edccd1a60a4834068024606c68ae7d97fdc0fdeecd7bd4d90
  no-mistakes-amd64 88b1a481924488f55456b3f96070f739b109e19555232e4f8be0a7ebae7c08ac
)
# Not installed here: Claude Code's own installer is an unpinned curl | bash, so we only print it.
claude_install='curl -fsSL https://claude.ai/install.sh | bash'

# version <tool>: first x.y.z in its version output, or empty.
version() {
  local out
  if [[ $1 == tmux ]]; then out=$(tmux -V 2>/dev/null); else out=$($1 --version 2>/dev/null | head -1); fi
  [[ $out =~ '[0-9]+\.[0-9]+(\.[0-9]+)?' ]] && print -r -- $MATCH
}

install_hint() {  # <name> <how> <pin>
  case $2 in
    brew) print "brew install $1" ;;
    npm) print "npm i -g $1@$3" ;;
    release) print "$self  (pinned v$3 from github.com/${repo[$1]})" ;;
    system) print "it ships with macOS; brew install $1" ;;
    claude) print $claude_install ;;
  esac
}

# release_install <name> <pin>: download the pinned archive, check its hash, put the binary in place.
release_install() {
  local name=$1 pin=$2 arch dir=${bindir[$1]} tmp file url
  case $(uname -m) in arm64) arch=arm64 ;; x86_64) arch=amd64 ;; *) print "unsupported CPU $(uname -m) for $name"; return 1 ;; esac
  file=$name-v$pin-darwin-$arch.tar.gz
  url=https://github.com/${repo[$name]}/releases/download/v$pin/$file
  if dry; then print -r -- "would download $url, check sha256 ${sha[$name-$arch]}, install to $dir/$name"; return 0; fi
  tmp=$(mktemp -d)
  curl -fsSL --max-filesize 100000000 $url -o $tmp/$file || { rm -rf $tmp; print "download failed: $url"; return 1 }
  [[ $(shasum -a 256 $tmp/$file) == ${sha[$name-$arch]}\ * ]] || { rm -rf $tmp; print "checksum mismatch for $file; not installed"; return 1 }
  tar -xzf $tmp/$file -C $tmp $name || { rm -rf $tmp; print "could not unpack $file"; return 1 }
  mkdir -p $dir
  install -m 755 $tmp/$name $dir/$name
  rm -rf $tmp
  print "installed $name v$pin to $dir/$name"
  if [[ $name == no-mistakes ]]; then
    # Same layout as its official installer: binary in ~/.no-mistakes/bin, command in ~/.local/bin.
    mkdir -p $HOME/.local/bin
    ln -sfn $dir/no-mistakes $HOME/.local/bin/no-mistakes
    # Its daemon keeps running the old binary until restarted.
    $dir/no-mistakes daemon restart >/dev/null 2>&1 || print "note: run: no-mistakes daemon restart"
  fi
}

rc=0 brew_ok=1 npm_ok=1
command -v brew >/dev/null || brew_ok=0
if [[ $mode == install ]]; then
  (( brew_ok )) || print "Homebrew is missing; install it from https://brew.sh (it asks for your password), then re-run $self."
fi
for t in $tools; do
  name=${t%%:*} rest=${t#*:}; how=${rest%%:*} rest=${rest#*:}; pin=${rest%%:*} req=${rest#*:}
  [[ $pin == - ]] && pin=
  have=
  if command -v $name >/dev/null; then have=$(version $name) || have='?'; fi
  state=ok
  if [[ -z $have ]]; then state=missing
  elif [[ -n $pin && $have != '?' ]] && ! is-at-least $pin $have; then state=old
  fi

  if [[ $mode == --status ]]; then
    case $state in
      ok) print -r -- "ok       $name $have${pin:+ (pin $pin)}" ;;
      old) print -r -- "old      $name $have, pin $pin (fix: $(install_hint $name $how $pin))" ;;
      missing) print -r -- "MISSING  $name${${req:#1}:+ (optional)} (install: $(install_hint $name $how $pin))" ;;
    esac
    [[ $state != ok && $req == 1 ]] && rc=1
    continue
  fi

  [[ $state == ok ]] && continue
  case $how in
    brew)
      if (( brew_ok )); then act brew install $name; else print "skipped $name: needs Homebrew"; rc=1; fi ;;
    npm)
      if ! command -v npm >/dev/null; then print "skipped $name: needs node/npm"; rc=1; continue; fi
      # A global prefix you cannot write (e.g. /usr/local from a pkg install) would need sudo; we don't.
      if (( npm_ok )) && [[ ! -w $(npm prefix -g) ]]; then
        print "npm's global folder $(npm prefix -g) is not writable; install Node with Homebrew, or set a user prefix (npm config set prefix ~/.local)."
        npm_ok=0
      fi
      (( npm_ok )) || { print "skipped $name: run npm i -g $name@$pin yourself"; rc=1; continue }
      act npm i -g --no-fund --no-audit $name@$pin
      # A first install also wires its agent SessionStart hook, as firstmate's own installer does.
      [[ $state == missing && $name == (gh-axi|chrome-devtools-axi|lavish-axi) ]] && act $name setup hooks ;;
    release)
      release_install $name $pin || rc=1 ;;
    system|claude)
      print "$name is missing; install it with: $(install_hint $name $how $pin)"; rc=1 ;;
  esac
done

if [[ $mode == install ]]; then
  (( ${path[(Ie)$HOME/.local/bin]} )) || print "Note: ~/.local/bin is not on PATH, so treehouse and no-mistakes won't be found. Add to ~/.zshrc: export PATH=\"\$HOME/.local/bin:\$PATH\""
fi
# Logins stay with you; these only say what to run. gh is required, the claude probe is best effort.
if command -v gh >/dev/null && ! gh auth status >/dev/null 2>&1; then print "MISSING  gh login (run: gh auth login)"; rc=1; fi
if command -v claude >/dev/null && ! claude auth status 2>/dev/null | grep -q '"loggedIn": *true'; then
  print "note     Claude Code may not be logged in (run: claude, then /login)"
fi
[[ $mode == install ]] && print "Per repo that should go through the no-mistakes gate, run once inside it: no-mistakes init"
exit $rc
