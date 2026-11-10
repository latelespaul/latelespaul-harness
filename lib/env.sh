# Loads harness.env (every per-user value) and fills in defaults. Sourced by every harness script.
# HARNESS_DIR is always the folder this copy of the framework lives in, whatever harness.env says.
_harness_lib=${${(%):-%x}:A:h}
HARNESS_ENV=${HARNESS_ENV:-${_harness_lib:h}/harness.env}
[[ -f $HARNESS_ENV ]] && source $HARNESS_ENV
HARNESS_DIR=${_harness_lib:h}
unset _harness_lib

# Values typed as ~/something.
for _k in PROJECTS_DIR PROFILE_DIR TELEGRAM_WORKDIR FIRSTMATE_DIR HS_ACCESS_FILE; do
  [[ ${(P)_k} == '~'* ]] && typeset -g $_k="$HOME${${(P)_k}#\~}"
done
unset _k

: ${PROJECTS_DIR:=$HOME/Projects}
: ${PROFILE_DIR:=$PROJECTS_DIR/agent-profile}
: ${PROFILE_REMOTE:=}
: ${GH_USER:=}
: ${LABEL_PREFIX:=${${(L)${GH_USER:-$USER}}//[^a-z0-9-]/}}
: ${MODULES:=}
: ${MEMORY_DIRS:=$HOME}
: ${SYNC_INTERVAL:=7200}
: ${FRAMEWORK_PUSH:=0}
: ${UPSTREAM_REMOTE:=origin}
: ${FORK_REMOTE:=fork}
: ${LOCAL_BRANCH:=local}
: ${BROWSER_PORT:=9222}
: ${BROWSER_EXTRA:=}
: ${TELEGRAM_WORKDIR:=$PROJECTS_DIR/claude-telegram}
: ${TELEGRAM_BRIEF_TIME:=08:30}
: ${FIRSTMATE_REPO:=https://github.com/kunchenguid/firstmate.git}
: ${FIRSTMATE_UPSTREAM:=}
: ${FIRSTMATE_DIR:=$PROJECTS_DIR/firstmate}
: ${FIRSTMATE_SESSION:=firstmate}
: ${FIRSTMATE_TELEGRAM:=0}
: ${FIRSTMATE_AUTOSTART:=1}
: ${CLAUDE_P_IGNORE_API_KEY:=0}
: ${HS_IPC_GENERIC:=1}
: ${HS_ACCESS_FILE:=$PROFILE_DIR/hammerspoon/access.json}
MEMORY_DIRS=${MEMORY_DIRS//\~/$HOME}

# Keys a template may use as __KEY__ (modules add their own).
render_keys=(HOME HARNESS_DIR PROFILE_DIR PROJECTS_DIR GH_USER LABEL_PREFIX MODULES SYNC_INTERVAL
  BROWSER_PORT TELEGRAM_WORKDIR FIRSTMATE_DIR FIRSTMATE_SESSION)
