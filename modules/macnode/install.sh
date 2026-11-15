#!/bin/zsh
# macnode module: a VM (the brain) asks this Mac (the hands) to run named actions, over an SSH link that
# only the Mac opens (SETUP.md). The same module installs on both sides; MACNODE_ROLE picks the side
# (empty = mac where launchd exists, else vm).
#   install.sh             install / repair. mac: links mac-node, registers the hcron keepalive job
#                          `mac-node` (never a launchd plist). vm: links mac-node, makes the state folders.
#   install.sh --status    mac: is the service running? vm: is the Mac link up? (exit 1 if not installed)
#   install.sh --uninstall mac: remove the hcron job (stop a running service with: pkill -f 'mac-node serve')
#   install.sh --key-line [pubkey-file|-]
#                          vm: print only the authorized_keys line for the Mac's dedicated public key
#                          (read from the file, or stdin for -). The line is
#                          restrict,command="<node> ~/.local/bin/mac-node bridge" <key>: no shell, no
#                          forwarding of any kind; whatever the Mac asks for, sshd runs the bridge.
set -e
(( ${argv[(Ie)--dry-run]} )) && { export HARNESS_DRY_RUN=1; argv=(${argv:#--dry-run}) }
source ${0:A:h:h:h}/lib/common.sh
mod=$HARNESS_DIR/modules/macnode
role=${MACNODE_ROLE:-$(have_launchd && print mac || print vm)}
[[ $role == (mac|vm) ]] || { print "MACNODE_ROLE is mac or vm, not '$role'."; exit 1 }
bin=$HOME/.local/bin/mac-node
hcron=(node $HARNESS_DIR/modules/cron/hcron.mjs)
# keyline <public key>: the VM's authorized_keys line. The forced command uses absolute paths, because
# sshd runs it with a bare environment.
keyline() {
  local node=${commands[node]:-}
  [[ -n $node ]] || { print -u2 "Install Node first: the bridge needs it."; return 1 }
  [[ $node$bin != *[\"\\\ ]* ]] || { print -u2 "a path holds a space, quote or backslash: $node $bin"; return 1 }
  print -r -- "restrict,command=\"$node $bin bridge\" $1"
}
key_re='^(ssh-ed25519|sk-ssh-ed25519@openssh\.com|ecdsa-sha2-nistp(256|384|521)|ssh-rsa) [A-Za-z0-9+/]+={0,3}( [A-Za-z0-9@._-]+)?$'

case ${1:-install} in
--status)
  [[ -L $bin || -x $bin ]] || { print "mac-node is not installed (run $0)."; exit 1 }
  if [[ $role == mac ]]; then
    $bin status && exit 0
    print "mac-node service is not running; hcron starts it within a minute (hcron status; hcron logs mac-node)."
    exit 1
  fi
  $bin status || true   # the Mac being away is not an install fault
  exit 0 ;;
--key-line)
  [[ $role == vm ]] || { print -u2 -r -- "--key-line runs on the VM (SETUP.md, Mac install step 4 runs it there over ssh)."; exit 1 }
  if [[ ${2:--} == - ]]; then key=$(head -c 4096); else key=$(head -c 4096 -- $2) || exit 1; fi
  key=${key%%$'\n'*}
  [[ $key =~ $key_re ]] || { print -u2 "not one OpenSSH public key line (want e.g. ssh-ed25519 AAAA... mac-node)"; exit 1 }
  keyline $key; exit ;;
--uninstall)
  if [[ $role == mac ]] && enabled cron; then act $hcron rm mac-node || true; fi
  print "mac-node job removed; $MACNODE_DIR is kept."
  exit 0 ;;
install) ;;
*) print "usage: $0 [--status|--uninstall|--key-line]"; exit 1 ;;
esac

command -v node >/dev/null || { print "Install Node first (brew install node)."; exit 1 }
ensure_dir $HOME/.local/bin
link $mod/mac-node.mjs $bin
act mkdir -p $MACNODE_DIR
act chmod 700 $MACNODE_DIR

if [[ $role == vm ]]; then
  for d in link queue results; do act mkdir -p $MACNODE_DIR/$d; act chmod 700 $MACNODE_DIR/$d; done
  print "mac-node (VM side) installed. The Mac's sshd stays off: the Mac dials in with its own key."
  print "  On the Mac, set in harness.env:  MACNODE_VM=$USER@<this VM's address>"
  print "  The Mac's key goes into ~/.ssh/authorized_keys here as one line (SETUP.md, Mac install step 4 sends it):"
  print -r -- "    $(keyline '<the Mac'"'"'s mac-node_ed25519.pub>')"
  print "  It runs only the bridge: no shell, no port or socket forwarding. The Mac sends it with:"
  print -r -- "    ssh <vm-login> 'umask 077; mkdir -p ~/.ssh; $mod/install.sh --key-line - >> ~/.ssh/authorized_keys' < ~/.ssh/mac-node_ed25519.pub"
  print "  Check:  mac-node status   (link: up once the Mac service runs)"
  exit 0
fi

# --- Mac side ---
todo=()
[[ -n $MACNODE_VM ]] || todo+="set MACNODE_VM=<user>@<vm address> in harness.env"
[[ -f $MACNODE_KEY ]] || todo+="make the dedicated key (no passphrase; it never leaves this Mac): ssh-keygen -t ed25519 -N '' -C mac-node -f $MACNODE_KEY"
enabled cron || todo+="add cron to MODULES: the service runs as the hcron keepalive job 'mac-node'"
if (( ${#todo} )); then
  print "mac-node needs:"; for t in $todo; do print -r -- "  - $t"; done
  print "then run $0 again."
  exit 1
fi
# Keepalive: hcron starts the service each minute unless it already runs (one copy, pid lock), and
# reports when it fails. The timeout only bounds one run (it restarts on the next tick).
act $hcron add mac-node --cron '* * * * *' --cmd "$bin serve" --timeout 720h
print "mac-node (Mac side) installed: hcron starts 'mac-node serve' within a minute."
print "  The VM's authorized_keys needs this key, restricted to the bridge (SETUP.md, Mac install step 4):"
print -r -- "    ssh <vm-login> 'umask 077; mkdir -p ~/.ssh; <vm-harness>/modules/macnode/install.sh --key-line - >> ~/.ssh/authorized_keys' < $MACNODE_KEY.pub"
print "  Then check from the VM:  mac-node ping"
