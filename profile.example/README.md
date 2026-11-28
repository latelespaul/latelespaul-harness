# My agent profile

Private data for my agent harness: who I am, my memory, and what my sessions learned. The framework that uses it lives in a separate repo (its path is under "Paths" in `~/.claude/CLAUDE.md`). Keep this repo private.

| Path | What it is |
|---|---|
| `ABOUT.md` | Who I am and my preferences; loaded into every session |
| `memory/` | Long-term memory (index in `MEMORY.md`, one fact per file) |
| `knowledge/` | Session log (`sessions/`) and reusable learnings |
| `secrets.md` | Where each secret lives. Locations only, never values |
| `skills/`, `commands/`, `agents/` | My own skills, slash commands and subagents |
| `settings.json` | Optional: Claude Code settings to merge into `~/.claude/settings.json` on every machine |
| `mcp.json` | Optional: MCP servers (`{"mcpServers": {"<name>": <claude mcp add-json config>}}`) that `install.sh` adds at user scope when missing |
| `telegram/`, `browser/` | Module data (bot owner, morning brief, site lists), when those modules are on |

Synced automatically by the harness (`scripts/sync.sh`, every 2 h, at login, and pulled at every session start).
