# Prints the telegram notes that depend on harness.env: polling off, and the mac-node hands link.
source ${0:A:h:h:h}/lib/env.sh
if [[ $TELEGRAM_POLLING == 0 ]]; then
  print -r -- "  - Polling is OFF on this machine (TELEGRAM_POLLING=0): \`claude-tg\` runs without the Telegram plugin and never polls the bot. Never start a Telegram poller here; the bot runs on the ACTIVE_HOST machine until a planned cutover."
fi
if [[ $TELEGRAM_MAC_NODE == 1 ]]; then
  print -r -- "- **mac-node**: this machine is the brain; the Mac is the hands. Reach the Mac only through \`mac-node\` (an outbound SSH link from the Mac; see \`mac-node --help\`). It runs only allowlisted actions with checked arguments, logs each request on both sides, and answers \`mac-offline\` (the job is queued and runs when the link returns) or \`locked\` instead of hanging. Never retry those in a loop.
  - Actions: eyes/hands status and calls via \`hsx\` (armed per call), \`chrome-mode\`, job-hunt \`bin/jobhunt\` subcommands, \`hcron status|pause|resume|run\`, the \`gh-code\` and \`portal-pass\` tools, and \`git pull\` of named repos. No shell strings or other commands.
  - Secrets (Keychain, Gmail OAuth, portal passwords) stay on the Mac: use them only through those actions, never copy them here."
fi
