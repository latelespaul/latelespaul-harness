# The explaining standard

Agents follow this standard when they explain something technical. That includes a concept, how a system works, how to do a task, why something broke, or which option to choose. Any model can follow it. The `explain` skill applies it, and `scripts/ste-check.mjs` checks a draft against it.

The standard fixes one problem. Answers often give fragments of a process: one command, one fact, one cause. The reader then cannot see the whole process, and the answer uses terms that it does not define. The standard asks for two things:

- **Writing rules** (part 3). Most of these rules come from ASD-STE100 (the specification for Simplified Technical English, STE). STE is the controlled language of aerospace maintenance manuals. Some rules are our own.
- **A structure** (part 2). The structure always shows the whole process from start to end, in order.

Contents:
1. How much to write (the scaling rule)
2. The structure: eight parts
3. Writing rules, with their STE sources
4. Templates for the four types of question
5. Chat and phone layout
6. Self-check before you send
7. The checker: `ste-check`
8. Before and after examples
9. Sources

## 1. How much to write (the scaling rule)

Find the type and the size of the question first. Then use only the parts that the size needs.

| Question | Example | Parts to use |
|---|---|---|
| A one-line fact | "What port does the agent browser use?" | 1 and 8 |
| A short "what is" | "What is `screen -r`?" | 1, 2, 4, 5, 7, 8 (3 and 6 when they help) |
| How it works, how to, why it broke, which to choose | "How does the scheduler work?" | All eight (procedure and decision may skip 3) |

Rules for size:
- When you are not sure, use the larger size. A missing step is a worse error than one extra part.
- Do not add a part only to fill the template. When a part has nothing to say, write one line that tells why (for example, "Terms: none new").
- A follow-up question gets only the parts that change. Do not repeat the full answer.

## 2. The structure: eight parts

Each part has a label. Keep the labels and the order, so the reader always knows where to look.

1. **Short answer.** One to three sentences that give the result. A reader who stops here must still have the main point. Do not add detail to make it look complete.
2. **Where it fits.** The context: which system this is part of, what comes before it and after it, and why it exists.
3. **The whole flow.** A diagram of the full process, from the first trigger to the last result. Use a small ASCII (plain text) diagram in a code block in chat. Use an image only when the flow is too big for ASCII.
4. **Step by step.** A numbered walk-through of the whole process, in the order that it happens. Every arrow in the diagram has a step. No step jumps ahead or leaves a gap.
5. **Terms.** Each technical term and acronym in the answer, with a one-line definition. Put a definition in the text at the first use too.
6. **Example.** One real case with real values: a real command, a real file, real times, real output.
7. **Edge cases and warnings.** What can go wrong, the limits, and the failure modes. In a procedure, put each warning before the step that it applies to (rule R10), and list it here too.
8. **Next.** What the reader can do now: a command to run, a thing to check, or a decision to make.

## 3. Writing rules, with their STE sources

The "Source" column gives the STE Issue 9 rule that a rule comes from. "Ours" marks a rule that STE does not contain. The notes after the table tell how we verified the rule numbers.

| ID | Rule | Source |
|---|---|---|
| R1 | Keep each sentence in a procedure (an instruction) to 20 words or fewer. | STE 5.1 |
| R2 | Keep each descriptive sentence to 25 words or fewer. | STE Section 6 (rule number not verified) |
| R3 | Write about one topic in each paragraph. | STE Section 6 (rule number not verified) |
| R4 | Write six sentences or fewer in each paragraph. | STE Section 6 (rule number not verified) |
| R5 | Use the active voice. Say who or what does the action. In descriptions, use the passive only when you do not know who does the action. | STE 3.6 |
| R6 | Use simple verb forms: the simple present, simple past or simple future tense, or the imperative. Do not use complex verb constructions ("would have been running"). | STE 3.2, 3.4 |
| R7 | Use one word for one meaning, and one name for one thing. Do not change between synonyms ("job", "task", "entry") for the same thing. | STE 1.3, 1.11, 9.4 |
| R8 | Define each technical term and acronym at its first use. | Ours (STE controls terms with its dictionary and technical-noun rules 1.5 to 1.11; it has no "define" rule) |
| R9 | Write each instruction in the imperative ("Run", "Open"), with one action in each step, unless two actions occur at the same time. | STE 5.3, 5.2 |
| R10 | Put each warning or caution before the step that it applies to. Start it with a signal word (WARNING, CAUTION), then a clear command, then the risk. | STE 7.1, 7.2, 7.3 (signal word, command, risk); the position before the step is ours |
| R11 | Use a vertical list for complex text, and a table to compare items. | STE 4.3 (vertical lists); tables are ours |
| R12 | Do not use "it", "this", "that" or "they" without a clear noun. Write "this file", not "this". | STE 4.5 (an article or demonstrative adjective before a noun); the pronoun rule is ours |
| R13 | Do not leave out words, and do not use contractions, to make a sentence shorter. | STE 4.2 |
| R14 | Do not make noun clusters of more than three nouns. | STE 2.1 |
| R15 | Use a verb for an action, not a noun ("restart the bot", not "do a restart of the bot"). | STE 3.7 |
| R16 | Use connecting words ("then", "because", "after that") between sentences on related topics. | STE 4.4 |
| R17 | Write notes to give information, not instructions. | STE 5.5 |
| R18 | Avoid vague words such as "handle", "deal with", "stuff" and "things". Name the action. | Ours |

How to count words (from STE, and what `ste-check` does):
- A hyphenated word counts as one word (STE 8.7).
- Text in parentheses counts as one word in the sentence (STE 8.5).
- A command, a code span, a number or a link counts as one word (STE 8.6 counts such elements as one word; we did not verify its exact list of elements).

What we do not adopt from STE:
- The STE dictionary of approved words (rules 1.1, 1.2, 3.1). We have no approved word list, so rule R8 asks for definitions instead.
- The ban on the semicolon (8.1) and the American spelling rule (1.14). Use them when they help. The checker does not look for them.

How we verified the rule numbers:
- The ASD (Aerospace, Security and Defence Industries Association of Europe) published ASD-STE100 Issue 9 on 15 January 2025. Issue 9 did not add new rules. It changed the wording of 31 of its 53 rules (source 1).
- The numbers for Sections 1 to 5 and 7 to 9 come from a term-checker vendor's summary of the Issue 9 rules (source 2). That summary gives the rules in its own words, not in the official text.
- That summary has no numbered rules for Section 6 (descriptive writing). It sends the reader to rule 5.1 for word counts. Other secondary sources give the 25-word and six-sentence limits for descriptive text (sources 3 and 4), but we could not verify their rule numbers. The table above gives no number for those rules.
- We did not read the official text. The ASD gives it free on request at asd-ste100.org. Check the numbers against that text before you cite them outside this harness.

## 4. Templates for the four types of question

Each template uses the eight parts. The label text changes a little to match the type. Copy a template, then fill it.

### 4.1 Concept, or how it works ("what is X", "how does X work")

```
**Short answer.** X is <what it is>. It <what it does> so that <why it matters>.
**Where it fits.** X sits between <A> and <B>. <A> gives it <input>; X gives <B> <output>.
**The whole flow**
  trigger -> step 1 -> step 2 -> result
**Step by step**
1. <Trigger> starts X.
2. X <does the first thing>.
3. ... (every step, in order, to the result)
**Terms**
- <term>: <one-line definition>.
**Example.** <A real case with real values, from start to end.>
**Edge cases and warnings.** <Limits. What fails, and what X does then.>
**Next.** <A command to see it, or the next thing to read.>
```

### 4.2 Procedure, or how to ("how do I X")

```
**Short answer.** To X, <do A>, then <do B>. It takes <time>.
**Before you start.** You need <prerequisites>. This changes <what>.
**Steps**
1. <Imperative verb> <one action>.
2. WARNING: <Command>. <The risk.>   (before the step it applies to)
3. <Imperative verb> <one action>.
**Terms**
- <term>: <definition>.
**Example.** <The real commands with real values, and their output.>
**If it fails.** <Symptom> means <cause>. <Fix>.
**Check it worked.** Run <command>. You see <result>.
```
The diagram is optional in a procedure. Add one when the steps move between two or more systems.

### 4.3 Troubleshooting, or why it broke ("why did X fail")

```
**Short answer.** X failed because <cause>. <Fix> repairs it.
**What should happen.** Normally, <the correct flow in one or two sentences>.
**The whole flow**
  A -> B -x C      (mark where it broke)
**How it failed**
1. <First event>.
2. <Next event>, because <reason>.
3. ... (the chain from the start to the failure)
**Terms**
- <term>: <definition>.
**Evidence.** <The real log line, error or value that shows the cause.>
**Other causes and warnings.** <Causes you ruled out, and how. Risks of the fix.>
**Next.** <The fix as steps, the command that shows it works, and how to stop a repeat.>
```

### 4.4 Decision, or comparison ("should I use X or Y")

```
**Short answer.** Use <X>, because <main reason>. Use <Y> only when <condition>.
**The decision.** You must choose <what> for <goal>. The limits are <constraints>.
**Options compared**
| | X | Y |
|---|---|---|
| <criterion> | <value> | <value> |
**Terms**
- <term>: <definition>.
**Example.** <A real case with numbers that shows the difference.>
**When the other option wins.** <Conditions that change the answer. Risks of X.>
**Next.** <The first step to take with X.>
```
The diagram is optional in a decision. The table does the work of the diagram.

## 5. Chat and phone layout

Many readers read answers in a chat app on a phone. Follow these rules in chat:

- Use bold labels (`**Short answer.**`) instead of `#` headings. Some chat apps do not show headings.
- Keep ASCII diagrams 40 characters wide or less, so that a phone does not wrap them.
- Put each step on its own line. Keep paragraphs to three sentences or fewer when you can.
- Put commands in code spans or code blocks, so that the reader can copy them.
- Do not use tables wider than three columns in chat. Use a list when a table is too wide.
- Send a long answer as one message. Do not split one answer into many fragments.

## 6. Self-check before you send

Check each item. Fix the draft before you send it.

1. The short answer gives the result in one to three sentences.
2. The size matches the question (part 1).
3. The steps show the whole process, from the trigger to the result, with no gap.
4. Each technical term and acronym has a definition at its first use.
5. Each sentence is 25 words or fewer; each instruction is 20 words or fewer.
6. Each sentence uses the active voice and a simple tense.
7. Each thing has one name in the full answer.
8. Each instruction has one action, and each warning comes before its step.
9. No "it", "this" or "that" is without a clear noun.
10. The example uses real values, and the last part tells the reader what to do next.

## 7. The checker: `ste-check`

`scripts/ste-check.mjs` checks a draft for the rules that a program can find. It needs only Node.js, with no packages.

```sh
node scripts/ste-check.mjs answer.md
pbpaste | node scripts/ste-check.mjs - --type procedure
node scripts/ste-check.mjs answer.md --json
```

It finds these problems:

| Finding | Rule | What it means |
|---|---|---|
| `sentence-length` | R1, R2 | A sentence has more than 25 words, or more than 20 words in a numbered step |
| `passive-voice` | R5 | A sentence is probably passive ("is started", "was sent") |
| `paragraph-length` | R4 | A paragraph has more than six sentences |
| `undefined-acronym` | R8 | An acronym has no definition anywhere in the text |
| `missing-section` | Part 2 | A long answer (over 150 words) does not have one of the eight parts |

How it works, and its limits:
- It skips code blocks and code spans, and it counts words as part 3 tells.
- It treats each sentence in a numbered list as an instruction (20 words). Other sentences are descriptions (25 words).
- The passive test is a pattern match. A past participle that names a state ("the screen is locked") is an adjective under STE 3.3, so the checker does not flag it unless "by" follows.
- It finds a part by its label: a `#` heading, a bold line, or a bold lead-in such as `**Example.**`. Bold text inside a list item is not a label. A fenced diagram with arrows also counts as part 3.
- It accepts an acronym as defined when the text has "(ACR)", "ACR (full name)", a "ACR: ..." line, or a table row that starts with the acronym. `--allow ACR,ACR` accepts more.
- `--type procedure` and `--type decision` make the diagram optional. `--structure` checks the parts on a short answer too, and `--no-structure` turns the parts check off.
- Exit codes: 0 when it finds no problem, 1 when it finds problems, and 2 for a usage error.
- It cannot check meaning: synonyms, vague words, the order of steps or a missing step. The self-check list covers those items.

Tests: `node --test scripts/ste-check.test.mjs`.

## 8. Before and after examples

These examples rewrite real answers to the standard. The "before" answers show the old style: correct facts, but only fragments of the process.

### 8.1 "What is `screen -r claude-tg`?"

Before:

> It reattaches to the screen session. Ctrl-A D to detach. If it says attached, use -d -r.

After:

---

**Short answer.** `screen -r claude-tg` connects your terminal to a program that already runs in the background, in a `screen` session with the name `claude-tg`. You see the program and can type to it. When you disconnect, the program continues to run.

**Where it fits.** The telegram module runs its chat bot session inside `screen`, so the session continues after you close your terminal. At login, a launchd agent starts the session. You connect only to answer a prompt or to look at the bot.

**The whole flow**
```
login -> launchd -> screen claude-tg
                      | runs
                      v
                   bot session
you: screen -r ---> see + type
     Ctrl-A D  ---> disconnect
```

**Step by step**
1. At login, launchd starts `screen` with the session name `claude-tg`.
2. The `screen` session starts the bot program and keeps it in the background.
3. You type `screen -r claude-tg` in a terminal.
4. `screen` connects your terminal to the session. You see the program screen.
5. You type into the program, for example to answer a prompt.
6. You press Ctrl-A, then D. `screen` disconnects your terminal, and the program continues.

**Terms**
- `screen`: a terminal multiplexer, a program that keeps terminal sessions alive without a window.
- Session: one program that `screen` keeps alive, with a name such as `claude-tg`.
- Reattach (`-r`): connect your terminal to a session again.
- Detach (Ctrl-A, then D): disconnect your terminal and leave the session alive.
- launchd: the macOS service manager that starts programs at login.

**Example.** `screen -ls` shows `12345.claude-tg (Detached)`. Then `screen -r claude-tg` connects you to the bot session.

**Edge cases and warnings**
- CAUTION: Do not press Ctrl-C and do not type `exit` in the session. The keys go to the program and can stop the bot.
- `There is no screen to be resumed` means that no session has that name. Run `screen -ls` to see the names.
- "Attached" means that another terminal shows the session. `screen -d -r claude-tg` disconnects that terminal and connects yours.

**Next.** Run `screen -ls` to see the sessions on this computer.

---

### 8.2 "How does Hammerspoon work technically?"

Before:

> It's a Lua automation app. The harness links init.lua and tools call `hs -c`. Grant Accessibility once.

After:

---

**Short answer.** Hammerspoon is one signed macOS app with a built-in Lua engine. Our tools send Lua code to the app, and the app runs that code with its own screen and keyboard permissions. Thus you grant the permissions one time, to one app.

**Where it fits.** macOS lets an app read the screen or control the mouse and keyboard only after you give permission. macOS stores each permission against the app's code signature. A tool that you build again gets a new signature and needs the permissions again. Code that runs inside Hammerspoon uses the permissions of Hammerspoon.

**The whole flow**
```
tool -> hs -c 'lua' -> message port
                          |
                          v
          Hammerspoon (signed, has
          Accessibility + Screen
          Recording) runs the Lua
                          |
tool <- printed result <--+
```

**Step by step**
1. At login, Hammerspoon starts and runs `~/.hammerspoon/init.lua`. The harness links that file.
2. `init.lua` turns on the `hs.ipc` module, which installs the `hs` command-line tool.
3. `init.lua` defines the `harness` functions, then loads each `.lua` file in `~/.hammerspoon/local/`, in name order.
4. A tool runs `hs -c 'return harness.status()'`.
5. The `hs` tool sends the Lua code to the running app through a local message port.
6. Hammerspoon runs the code with its permissions, and `hs` prints the result.
7. The tool reads the printed JSON line and decides what to do.

**Terms**
- Lua: a small programming language that Hammerspoon runs.
- Accessibility, Screen Recording: macOS permissions to control the mouse and keyboard, and to read the screen.
- Code signature: the identity that macOS stores for an app. A rebuilt tool gets a new identity.
- JSON (JavaScript Object Notation): a text format for data.
- `hs`: the command-line tool that sends Lua code to Hammerspoon.

**Example.** `hs -c 'return harness.status()'` prints `{"accessibility":true,"screen_recording":true,"screen_locked":false,...}`. The scheduler reads `screen_locked` before it starts a job that needs the screen.

**Edge cases and warnings**
- WARNING: Review each file in `~/.hammerspoon/local/`. That code gets full control of the screen and keyboard.
- When a local file has an error, Hammerspoon writes the error to its console and loads the other files.
- When a permission is off, `harness.status()` shows `false`. `hs -c 'return harness.request()'` opens the permission prompts.
- When Hammerspoon does not run, `hs` fails. The scheduler then uses `ioreg` to find the lock state.

**Next.** Run `modules/hammerspoon/install.sh --status` to see the permissions.

---

### 8.3 "How does the hcron scheduler work?"

Before:

> One LaunchAgent runs `hcron tick` every minute. Jobs are in jobs.json. Use --catchup for missed runs and --needs gui for screen jobs.

After:

---

**Short answer.** `hcron` is one scheduler for all the jobs on a Mac. A single launchd agent runs `hcron tick` every minute. Each tick starts the jobs that are due, one copy of each, and reports each failure.

**Where it fits.** Without `hcron`, each job needs its own launchd file. With `hcron`, each project adds jobs to one jobs file with `hcron add`, and one agent runs them all.

**The whole flow**
```
launchd (every min) -> hcron tick
  for each job in jobs.json:
  due? -> window? -> screen ok?
       -> already running? -> start
start -> supervisor -> zsh job
         timeout, exit code, log
         failure -> notify
```

**Step by step**
1. launchd runs `hcron tick` every minute.
2. The tick reads the jobs file. When `hcron pause all` is on, the tick stops here.
3. For each job, the tick finds the cron times since its last check.
4. The tick skips a missed time (the Mac was asleep) unless the job has `--catchup`.
5. The tick skips the job when the time is outside its `--window`.
6. For a `--needs gui` or `--needs unlocked` job, the tick asks Hammerspoon for the lock state. It skips the job when the screen is locked, and it sends one notice.
7. The tick skips the job when the job's last process is still alive. Thus a job never runs twice at the same time.
8. The tick starts a supervisor process. The supervisor runs the command in `zsh`, in the job's folder.
9. `caffeinate` keeps the Mac awake while the job runs.
10. At the timeout (55 minutes by default), the supervisor stops the job and every process that it started.
11. The supervisor writes the exit code to the job's state and the output to its log.
12. On the first failure, and on every fifth failure in a row, `hcron` sends a notice.

**Terms**
- launchd: the macOS service manager. It runs `hcron tick` every minute.
- Cron expression: five fields (minute, hour, day, month, weekday) that give the run times.
- Tick: one pass of `hcron` over all jobs.
- Supervisor: the `hcron` process that runs one job and records its result.
- Catch-up: one run of a time that the Mac missed while it was asleep.
- GUI (graphical user interface): the screen, mouse and keyboard.

**Example.** `hcron add backup --cron "30 2 * * *" --cmd "scripts/backup.sh" --timeout 30m --catchup` adds a backup job at 02:30. The Mac sleeps from 01:00 to 07:10. At 07:10 the tick finds the missed 02:30 time and starts the job one time. `hcron logs backup` shows `start (catchup ...)`, then `exit 0 after 42s`.

**Edge cases and warnings**
- CAUTION: Do not add a launchd file for a new job. Two schedulers can run the same job twice.
- A job without `--catchup` does not run after sleep. The log shows "missed slot".
- When the job folder is gone, `hcron` does not start the job, and it sends a notice.
- Without the telegram module, notices go only to the logs in `~/Library/Logs/hcron/`.

**Next.** Run `hcron status` to see each job, its next time and the lock state.

---

## 9. Sources

1. ASD, "Simplified Technical English ASD-STE100 Issue 9" (news, 2025): https://asd-europe.org/news-media/news-events/news/simplified-technical-english-asd-ste100-issue-9 . About STE, and the free copy on request: https://asd-ste100.org/about_STE.html
2. TechScribe, "Term checker rules for ASD-STE100 issue 9" (a summary of the rules, not the official text): https://simplified-english.co.uk/rules-ste9.html
3. TechScribe, "ASD-STE100 Simplified Technical English" (overview, gives the 25-word descriptive limit): https://techscribe.co.uk/techw/asd-simplified-technical-english.htm
4. Wikipedia, "Simplified Technical English" (gives the 20-word, 25-word and six-sentence limits): https://en.wikipedia.org/wiki/Simplified_Technical_English
