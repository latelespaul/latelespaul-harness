---
name: extend-first
description: Reuse-first workflow for ANY change - a feature, fix, skill, module, script, command, hook, doc, rule or config. Load it FIRST, before your first search, file read or edit, whenever the user asks to add, build, create, make, write, change, update, improve, fix, refactor or set up something ("new skill", "new module", "new script", "make a skill for X", "can we have a tool that...", "refactor X"), or when you are about to create a new file, skill or module yourself, even if the user never says "reuse" or "extend". It gives the steps - search what already exists, extend or adapt it, and build something new only when nothing fits. Not for questions, lookups or explanations that change nothing.
---

# Extend first

Most new asks overlap with something that already exists. A second skill or script for the same
topic splits the knowledge, and agents then pick the wrong one. So every change starts with a search,
and the default result is "extend the existing thing".

Examples from this harness:
- A user asked for a new "agent-doctor" skill. The `always-on` skill already covered recovery, so the change
  extended `always-on`.
- `docs/eyes-hands-design.md` extended `skills/eyes-hands` and did not add a second skill.

## The four steps

Do the steps in order. Keep each one short for a small change.

1. **Understand the ask.** Write down three facts: what it is for, who uses it, and where it runs
   (which Mac, server, cloud session, project or module).
2. **Analyse what exists.** Search the places below for anything that does the job or part of it.
   Search by topic words, not only by the name the user said. Read the best matches.
3. **Decide.** Use the decision table. Pick one row and write one line of reason.
4. **Plan, build, test, report.** Plan the smallest change inside the existing structure. Make it,
   run its tests or checks, then report in the format below.

## Where to look

In this harness (`HARNESS_DIR`):
- `skills/*/SKILL.md`: read each `description`. A skill that triggers on the same asks is a match.
- `modules/*/`: `SETUP.md`, `install.sh`, the module's `skill/` template and its scripts.
- `scripts/`: shared tools (`upstream.sh`, `sync.sh`, `retro.sh`, `rule-lint.mjs`, `ste-check.mjs`).
- `docs/`: design docs and standards (`operating-model.md`, `master-session.md`, `*-design.md`).
- `AGENTS.md`, `CONTRIBUTING.md`, `README.md`, `commands/`, `agents/`.

Outside the harness:
- The profile (`PROFILE_DIR` in `harness.env`): its `skills/`, `commands/`, `knowledge/learnings.md`
  and `memory/`. A profile skill with the same name wins over a harness skill.
- The installed set: `ls ~/.claude/skills ~/.claude/commands` shows what agents can already use.
- In a project: its README, `docs/` or design docs, `AGENTS.md` or `CLAUDE.md`, and the code near
  the change.

Quick search. Agent shells do not export `HARNESS_DIR` or `PROFILE_DIR`. Set both first from the
"Paths" section of `~/.claude/CLAUDE.md`. An empty result with unset paths does not mean "nothing exists".
```sh
: "${HARNESS_DIR:?set it first}" "${PROFILE_DIR:?set it first}"
grep -ril "<topic word>" "$HARNESS_DIR"/{skills,modules,scripts,docs} "$PROFILE_DIR"/{skills,knowledge}
grep -h '^description:' "$HARNESS_DIR"/skills/*/SKILL.md "$PROFILE_DIR"/skills/*/SKILL.md
```

## Decision table

| What you found | Decision | What to do |
|---|---|---|
| A thing that does the job or most of it | **Extend** | Add the new requirement to it. Keep its name, style and structure. |
| A thing that does a related job, but its shape does not fit | **Adapt** | Change it so it covers both jobs (a new option, section or mode). Keep old callers working. |
| Nothing that fits, or the fit would break its purpose | **New** | Build the smallest new thing. Link it from the closest existing doc or skill. |

Rules for the table:
- Two near matches: extend the one that its users already reach first.
- "New" needs one line that names the closest existing part and says why it does not fit.
- A rule that only applies to one person goes to the profile, not the harness (AGENTS.md
  "Changing the harness").
- Do not copy text from the existing thing into the new one. Point to it.

## When the change is a skill

Hand step 4 to the `skill-creator` skill:
- **Extend or adapt** an existing skill: use skill-creator's improve flow on that skill. Keep its
  name, and update its description if the new asks need new trigger words.
- **New** skill: use skill-creator's create flow. Check the new description against the existing
  descriptions, so two skills do not trigger on the same ask.

## Report format

End with three lines:
```
Decision: extended <X> | adapted <X> | new <Y>, because <one line>
Change:   <files changed, one line>
Checks:   <what you ran and the result; what you did not run>
```
