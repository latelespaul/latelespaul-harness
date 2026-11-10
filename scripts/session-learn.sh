#!/bin/zsh
# SessionEnd hook: summarises the session's findings and reusable knowledge into the profile's knowledge/.
# Reads the hook JSON on stdin, then does the work in the background so exiting Claude isn't delayed.
[[ -n $HARNESS_LEARN ]] && exit 0   # the summariser's own session must not trigger another run
source ${0:A:h:h}/lib/env.sh
kb_dir=$PROFILE_DIR/knowledge logs=$HARNESS_DIR/logs
input=$(cat)
transcript=$(jq -r '.transcript_path // empty' <<<$input)
cwd=$(jq -r '.cwd // empty' <<<$input)
[[ -f $transcript ]] || exit 0
mkdir -p $logs

(
  export HARNESS_LEARN=1 PATH=$HOME/.local/bin:/opt/homebrew/bin:/usr/bin:/bin
  # CLAUDE_P_IGNORE_API_KEY=1: use the claude.ai subscription login, not an API key from the shell.
  [[ $CLAUDE_P_IGNORE_API_KEY == 1 ]] && unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
  # User and assistant text only, last ~60k characters.
  convo=$(jq -r '
    select(.type == "user" or .type == "assistant")
    | .message.content as $c
    | ($c | if type == "string" then . else (map(select(.type == "text") | .text) | join("\n")) end) as $t
    | select($t != "")
    | "\(.type | ascii_upcase): \($t)"' $transcript 2>/dev/null | tail -c 60000)
  # Skip trivial sessions.
  (( $(grep -c '^USER: ' <<<$convo) >= 3 )) || exit 0

  out=$(print -r -- $convo | claude -p --model haiku --tools "" --no-session-persistence \
"Below is a transcript of a coding session (working folder: $cwd). Write a short record of it in exactly this format and nothing else:

TITLE: <max 8 words>
FINDINGS:
- <what was done, decided or discovered; 1-5 bullets, short>
KNOWLEDGE:
- <reusable, non-obvious knowledge worth keeping for future sessions: gotchas, commands, how things work; 0-3 bullets, or the single word NONE>

Never include secret values (tokens, keys, passwords). Write in English." 2>/dev/null) || exit 0
  [[ $out == TITLE:* ]] || exit 0

  mkdir -p $kb_dir/sessions
  title=${${(f)out}[1]#TITLE: }
  findings=$(sed -n '/^FINDINGS:/,/^KNOWLEDGE:/p' <<<$out | sed '1d;$d')
  knowledge=$(sed -n '/^KNOWLEDGE:/,$p' <<<$out | sed '1d' | grep '^- ' | grep -v -- '- NONE')

  log=$kb_dir/sessions/$(date +%Y-%m).md
  [[ -f $log ]] || print "# Sessions $(date +%Y-%m)\n" > $log
  print -r -- "## $(date '+%Y-%m-%d %H:%M') · ${cwd/#$HOME/~} · $title
$findings
" >> $log

  if [[ -n $knowledge ]]; then
    kb=$kb_dir/learnings.md
    [[ -f $kb ]] || print "# Learnings\n\nReusable knowledge collected from sessions. Newest at the bottom.\n" > $kb
    print -r -- "$knowledge" | sed "s/\$/ _($(date +%Y-%m-%d))_/" >> $kb
  fi
) >>$logs/session-learn.log 2>&1 &!
exit 0
