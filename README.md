# Hydra

Talk to many Claude Code (or Codex) sessions from Slack or Discord. Each session gets its own thread and its own tmux window, so you can read it in chat or attach to the terminal.

**Example.** In your main thread: `spawn: fix the 5 easiest tech-debt tickets`. Hydra opens five threads (spark, pixel, glyph...), each with its own worktree. Each reports back to the main thread when done. To see what one is really doing: `tmux attach -t <name>`.

**Why not sub-agents?** A sub-agent hides inside one session. Here every session has a thread you can read, interrupt and steer, and sessions message each other.

- Commands: `spawn:`, `kill:`, `review <PR>` (a builder and an adversarial reviewer talk in a thread), `help` lists the rest. Session names are just unique IDs: a new session gets the catalog name used least recently (one never used first), and `session-<hex>` only when every name is held by a live session.
- Setup: see [Quick Start](#quick-start), then [Discord](docs/discord.md) or [Slack](docs/slack.md).

## Architecture

```
┌─────────────┐     ┌─────────────┐
│  Discord    │     │   Slack     │
│  Gateway    │     │  Gateway    │
│ (discord.js)│     │(@slack/bolt)│
└──────┬──────┘     └──────┬──────┘
       │                   │
       └────────┬──────────┘
                │
       ┌────────▼────────┐
       │     Daemon      │     Single process per platform.
       │  (daemon.ts)    │     Holds gateway connection,
       │                 │     routes messages, manages
       │  unix socket    │     sessions and access control.
       └────────┬────────┘
                │  newline-delimited JSON
       ┌────────▼────────┐
       │    Bridge       │     Thin MCP relay. One per
       │  (bridge.ts)    │     Claude session. Platform-
       │                 │     agnostic — doesn't import
       │  stdio ↔ socket │     any chat SDK.
       └────────┬────────┘
                │  MCP (stdio)
       ┌────────▼────────┐
       │   Claude Code   │     Full Claude with tools,
       │                 │     memory, file access, etc.
       └─────────────────┘
```

**Key design decisions:**
- **One gateway connection per platform.** Prevents token race conditions (Discord) and simplifies state.
- **Daemon ↔ Bridge separation.** The daemon is long-lived; Claude sessions come and go. The bridge reconnects automatically.
- **Platform selection via env var.** Set `CHAT_PLATFORM=discord` or `CHAT_PLATFORM=slack`. Default: `discord`.
- **Simultaneous platforms.** Run two daemons on different state dirs for Discord + Slack at the same time, or attach Slack workspaces to an existing daemon via the [Slack connector](docs/slack.md).

## Prerequisites

- [Bun](https://bun.sh), the version `.tool-versions` pins — `asdf install`, or any install of that version. The daemon runs it whatever bun starts the CLI, and falls back to the bun on PATH, with a warning, when it is missing.
- [tmux](https://github.com/tmux/tmux) — `brew install tmux`
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — `npm install -g @anthropic-ai/claude-code`

## Quick Start

```bash
# 1. Install dependencies
bun install

# 2. Run the guided setup (prints Slack's 1-click manifest link or Discord's invite link,
#    verifies tokens live, pairs you as operator by DM code or ID, writes .env + hydra.toml,
#    installs the bridge plugin + launchd watchdog, and runs preflight)
bun cli/hydra.ts init discord   # or: bun cli/hydra.ts init slack

# 3. If preflight flags Claude login or onboarding, run `claude` once in a terminal

# 4. Start
hydra up discord                # or: hydra up slack
```

Manual setup without the wizard: see [Discord](docs/discord.md) or [Slack](docs/slack.md) (`install` → `migrate --operator` → `preflight` → `up`).

## Platform Setup

- **[Discord Setup](docs/discord.md)** — bot creation, token, permissions, first operator
- **[Slack Setup](docs/slack.md)** — the Slack gateway (the operator's chat surface): app manifest, Socket Mode, tokens; and the Slack connector (events routed by hydra.toml)

## Docs

- [Concepts](docs/concepts.md): the words hydra uses and how the pieces connect.
- [Reference](docs/reference.md): CLI, configuration, tools, sessions, troubleshooting.
- [Access control](ACCESS.md): who the bot hears, and upgrading from `access.json`.
- [Discord](docs/discord.md) and [Slack](docs/slack.md) setup; [Slack connector](docs/slack-connector.md), [specialists](docs/specialists.md), [schedules](docs/schedules.md), [handoff](docs/handoff.md).
- Every `hydra.toml` key: [`hydra.example.toml`](hydra.example.toml). Every command: `hydra --help`.
