---
name: explain
description: Apply the harness explaining standard (whole process, STE-style writing) to any technical explanation. Use whenever the user asks a technical "how", "why", "what is", "explain", "walk me through", "how does X work", "why did X break", "how do I X" or "X or Y?" question, or asks you to explain a concept, a design, code, a command, an error or a decision, before you write the answer.
---

# Explain

Write every technical explanation to the explaining standard. The full standard, with its STE rule sources and three before/after examples, is `docs/explaining-standard.md` in the harness (this skill lives in the harness's `skills/explain/`). This file is the working copy for while you write.

The goal: the reader sees the **whole process**, from start to end, in order, with every term defined. Do not answer with fragments (one command, one cause, one fact) when the question asks how or why.

## 1. Pick the type and the size

Types:
- **Concept / how it works**: "what is X", "how does X work".
- **Procedure / how to**: "how do I X", "set up X".
- **Troubleshooting / why it broke**: "why did X fail", "X does not work".
- **Decision / comparison**: "X or Y", "should I".

Size (the scaling rule):
- A one-line fact: parts 1 and 8 only.
- A short "what is": parts 1, 2, 4, 5, 7 and 8. Add 3 and 6 when they help.
- How it works, how to, why it broke, which to choose: all eight parts. A procedure or a decision may skip the diagram.
- Not sure? Use the larger size. A follow-up question gets only the parts that change.

## 2. The eight parts, in this order

Use bold labels (`**Short answer.**`), not `#` headings: chat apps on phones may not show headings.

1. **Short answer.** One to three sentences with the result.
2. **Where it fits.** The context: what this is part of, what comes before and after, why it exists.
3. **The whole flow.** An ASCII diagram in a code block, 40 characters wide or less.
4. **Step by step.** A numbered walk-through of the whole process, in order, with no gap.
5. **Terms.** Each technical term and acronym, with a one-line definition.
6. **Example.** One real case with real values: commands, files, times, output.
7. **Edge cases and warnings.** Limits and failure modes. In a procedure, each warning also comes before its step.
8. **Next.** What the reader can do now.

## 3. Templates

Concept / how it works:
```
**Short answer.** X is <what>. It <does what> so that <why>.
**Where it fits.** X sits between <A> and <B>.
**The whole flow**   (ASCII diagram, trigger -> ... -> result)
**Step by step**     1. <Trigger> starts X.  2. X <does> ...
**Terms**            - <term>: <definition>.
**Example.**         <a real case, start to end>
**Edge cases and warnings.** <what fails, and what X does then>
**Next.**            <a command to run or a thing to read>
```

Procedure / how to:
```
**Short answer.** To X, <do A>, then <do B>.
**Before you start.** <prerequisites; what this changes>
**Steps**            1. <Verb> <one action>.  2. WARNING: <command>. <risk>.  3. ...
**Terms** · **Example.** (the real commands and output)
**If it fails.**     <symptom> means <cause>. <fix>.
**Check it worked.** Run <command>. You see <result>.
```

Troubleshooting / why it broke:
```
**Short answer.** X failed because <cause>. <fix> repairs it.
**What should happen.** <the correct flow>
**The whole flow**   (mark where it broke: A -> B -x C)
**How it failed**    1. <first event>.  2. <next event>, because <reason>. ...
**Terms** · **Evidence.** (the real log line or error)
**Other causes and warnings.** <causes ruled out; risks of the fix>
**Next.**            <the fix, how to verify it, how to stop a repeat>
```

Decision / comparison:
```
**Short answer.** Use <X>, because <reason>. Use <Y> only when <condition>.
**The decision.**    <what must be chosen, for what goal, with what limits>
**Options compared** (a table of 3 columns or fewer, or a list)
**Terms** · **Example.** (a real case with numbers)
**When the other option wins.** <conditions; risks>
**Next.**            <the first step>
```

## 4. Writing rules (STE-style)

- Sentences: 25 words or fewer; instructions 20 or fewer (STE 5.1).
- Paragraphs: one topic, six sentences or fewer; three or fewer in chat.
- Active voice: say who or what does the action (STE 3.6).
- Simple tenses: simple present, simple past, simple future, imperative (STE 3.2).
- One word for one meaning, one name for one thing; no synonyms for the same thing (STE 1.3, 1.11).
- Define each technical term and acronym at its first use.
- Instructions: imperative, one action per step (STE 5.2, 5.3).
- Warnings: before the step, signal word first, then the command, then the risk (STE 7.1 to 7.3).
- Lists for complex text (STE 4.3); tables to compare.
- No "it", "this" or "that" without a clear noun (STE 4.5); no vague verbs such as "handle".
- No contractions, and no left-out words (STE 4.2).

## 5. Self-check before you send

1. The short answer gives the result in one to three sentences.
2. The size matches the question.
3. The steps show the whole process from trigger to result, with no gap.
4. Each term and acronym has a definition at its first use.
5. Sentence lengths and the active voice follow the rules.
6. Each thing has one name in the full answer.
7. Each instruction has one action; each warning comes before its step.
8. No pronoun is without a clear noun.
9. The example uses real values; the last part says what to do next.

For a long answer, run the checker on the draft when a shell is available, then fix what it finds:

```sh
node <harness>/scripts/ste-check.mjs - --type concept < draft.md
```

`--type` is `concept`, `procedure`, `troubleshooting` or `decision`. Exit 0 means no findings. The checker cannot check meaning, so the self-check list still applies.
