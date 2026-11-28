# Upstream

From github.com/kunchenguid/no-mistakes (MIT), tag `v1.106.1` (commit `5732d1ed88a1572fa6115d6ede5d69bfec097946`), file `skills/no-mistakes/SKILL.md`.
No harness changes: the file is byte-identical to what that CLI version's `no-mistakes init` writes to
`~/.claude/skills/no-mistakes/SKILL.md`, so a re-init through the link leaves git clean.
(It replaced an older copy that an earlier `no-mistakes init` had left in `~/.claude/skills`.)

The CLI is not vendored. Install it with the upstream installer (not npm):
`curl -fsSL https://raw.githubusercontent.com/kunchenguid/no-mistakes/main/docs/install.sh | sh`,
or pinned and checksummed with `modules/firstmate/tools.sh`.

Upgrade: when the CLI version changes, re-copy `skills/no-mistakes/SKILL.md` from the matching tag
(`gh api 'repos/kunchenguid/no-mistakes/contents/skills/no-mistakes/SKILL.md?ref=v<version>' -q .content | base64 -d`)
and update the tag and commit above. `no-mistakes init` refreshes the skill through the
`~/.claude/skills/no-mistakes` link, so after an upgrade it shows up as a diff here; commit it the same way.
