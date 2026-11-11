# Prompt: build a design-doc review tool (review-axi)

Use this prompt to have an agent build, from scratch, a small CLI that lets the agent show you a
design doc in your browser and get your comments back. It follows the AXI style: a CLI made for
agents to call, with short output and a hint for the next step.

**What you need:** Node, a browser, and about 1 to 2 days of agent work. Give it to your coding
agent (or firstmate) as a new repo.

**How it works**

```
agent writes doc.html ─► review-axi open ─► browser: you highlight + comment ─► "Send to agent"
        ▲                                                                          │
        └── agent edits doc ◄── review-axi reply ◄── review-axi poll (prints comments)
```

## The prompt (copy from here)

```text
Build "review-axi", a CLI that lets an agent show me a design doc in my browser and get my
comments back.

Loop:
1. The agent writes an HTML doc.
2. `review-axi open doc.html` serves it on localhost and opens the browser.
3. I select text, add comments, and click "Send to agent".
4. `review-axi poll doc.html` waits until I send, then prints my comments.
5. `review-axi reply doc.html "text"` shows the agent's answer on the page.
6. The agent edits the HTML; the page reloads and keeps my comments.

Parts:
- Node CLI, no build step, zero or few dependencies.
- Local HTTP server: one port, many docs, bound to 127.0.0.1 only.
- Overlay script injected into the page: highlight, comment, resolve, send.
- Comments stored in a JSON file next to the doc, anchored to the quoted text so they survive
  edits.
- Long-poll endpoint for `poll`, with a timeout and a clear "no feedback yet" result.

AXI rules (agent-friendly output):
- Short, flat output; no colours or spinners.
- Every result ends with a "next:" hint (the command to run next).
- Clear exit codes; every error says how to fix it.
- `--help` fits on one screen.

Also: tests, a README, and a SKILL.md that tells agents when and how to use the tool.
```

## Tips
- Ask for one end-to-end test that opens a doc, posts a comment, and reads it back with `poll`.
- If comments lose their place after edits, ask for fuzzy re-anchoring (nearest match of the
  quoted text).
- Keep the server local only. A review page should never be reachable from the network.
