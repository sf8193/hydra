# Hydra

Multi-platform chat bridge for Claude Code. Connect Claude to Discord, Slack, or both simultaneously via MCP.

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
- **Simultaneous platforms.** Run two daemons on different `DISCORD_STATE_DIR` paths for Discord + Slack at the same time.

## Prerequisites

- [Bun](https://bun.sh) — `curl -fsSL https://bun.sh/install | bash`
- [tmux](https://github.com/tmux/tmux) — `brew install tmux`

## Quick Start

```bash
# Install dependencies
bun install

# Start daemon (default: Discord)
./start-daemon.sh

# Start Claude session
./start-byte-v2.sh
```

## Platform Setup

- **[Discord Setup](docs/discord.md)** — bot creation, token, permissions, pairing
- **[Slack Setup](docs/slack.md)** — app manifest, Socket Mode, tokens

## Configuration

### Platform selection

Set in `~/trading/discord-bot-custom/.env`:

```bash
CHAT_PLATFORM=discord    # or slack

# Discord
DISCORD_BOT_TOKEN=MTIz...

# Slack
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
```

Discord bot token can also live in `~/.claude/channels/discord/.env` (loaded as fallback).

### Access control

`access.json` controls who can message the bot. Lives in the state dir (`~/.claude/channels/discord/` by default, or wherever `DISCORD_STATE_DIR` points).

```jsonc
{
  "dmPolicy": "pairing",          // pairing | allowlist | disabled
  "allowFrom": ["user-id-here"],  // platform user IDs
  "groups": {                      // channel-level policies
    "channel-id": {
      "requireMention": true,
      "allowFrom": [],
      "threadReply": true
    }
  },
  "ackReaction": "👀",
  "replyToMode": "first",         // first | all | off
  "textChunkLimit": 2000,
  "chunkMode": "newline"           // newline | length
}
```

See [ACCESS.md](./ACCESS.md) for full reference.

### Running both platforms simultaneously

Each platform needs its own daemon (separate state dir + socket) and its own Claude session. They can use different `CLAUDE_CONFIG_DIR` values for separate logins.

```bash
# Discord daemon (default state dir)
./start-daemon.sh
./start-byte-v2.sh  # uses CLAUDE_CONFIG_DIR=~/.claude-personal

# Slack daemon (separate state dir + socket)
DISCORD_STATE_DIR=~/.claude/channels/slack CHAT_PLATFORM=slack \
  bun run daemon.ts

# Slack Claude session (different config dir, different cwd)
export DAEMON_SOCK=~/.claude/channels/slack/daemon.sock
export CLAUDE_CONFIG_DIR=~/.claude
claude --channels plugin:discord@claude-plugins-official
```

**Requirements for each platform:**
- Its own `access.json` with platform-specific user IDs
- `discord@claude-plugins-official` enabled in the `CLAUDE_CONFIG_DIR`'s `settings.json`
- bridge.ts copied into the `CLAUDE_CONFIG_DIR`'s plugin cache
- `DAEMON_SOCK` must be `export`ed so the bridge subprocess inherits it
- `HYDRA_BRIDGE_AUTOCONNECT=1` must be `export`ed in byte's launch shell. Without it the bridge stays dormant and never registers, so the daemon has no session to route to. The provided `start-byte-v2.sh` / `start-slack-byte.sh` already set it; if you roll your own launcher, include it. Daemon-spawned sub-sessions get it automatically.

## Tools

| Tool | Description |
|------|-------------|
| `reply` | Send a message. Takes `chat_id` + `text`, optionally `reply_to` for threading and `files` for attachments (max 10, 25MB each). Auto-chunks long messages. |
| `react` | Add emoji reaction to a message. |
| `edit_message` | Edit a previously sent message. |
| `fetch_messages` | Pull recent history (up to 100). |
| `download_attachment` | Download attachments from a message to local inbox. |
| `create_thread` | Create a thread on a message or standalone. |
| `spawn_session` | Spawn a new Claude session for a topic (main session only). |
| `list_sessions` | List active spawned sessions (main session only). |
| `kill_session` | Kill a spawned session (main session only). |

## Sessions

Spawn isolated Claude sessions from chat:

| Command | Action |
|---------|--------|
| `spawn: <topic>` | Create a new session with a thread |
| `kill: <name>` | Kill a session by name |
| `/sessions` | List active sessions |
| `listen` / `pause` | Toggle auto-routing in a session thread |
| `help` / `commands` | Show all available commands |

Sessions get cute names (spark, pixel, nova...) and run in their own tmux sessions. State persists across daemon restarts. Kill them manually with `kill: <name>`.

## Files

| File | Purpose |
|------|---------|
| `gateway.ts` | ChatGateway interface and shared types |
| `discord-gateway.ts` | Discord implementation (discord.js) |
| `slack-gateway.ts` | Slack implementation (@slack/bolt Socket Mode) |
| `daemon.ts` | Platform-agnostic message router and session manager |
| `bridge.ts` | MCP relay between Claude and daemon (unix socket ↔ stdio) |
| `start-daemon.sh` | Start daemon in tmux |
| `start-byte-v2.sh` | Start main Claude session in tmux |
