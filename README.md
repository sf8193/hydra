# Hydra

A new interface to building — run coding agents over Discord/Slack.

- Spawn and manage parallel agents from chat
- tmux in to manage from terminal

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
- **Simultaneous platforms.** Run two daemons on different state dirs for Discord + Slack at the same time.

## Prerequisites

- [Bun](https://bun.sh) — `curl -fsSL https://bun.sh/install | bash`
- [tmux](https://github.com/tmux/tmux) — `brew install tmux`
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — `npm install -g @anthropic-ai/claude-code`

## Quick Start

```bash
# Install dependencies
bun install

# Create .env with your bot token
mkdir -p ~/.claude/channels/discord
cat > ~/.claude/channels/discord/.env << 'EOF'
DISCORD_BOT_TOKEN=your-token-here
EOF

# Install watchdog + verify setup
bun cli/hydra.ts install discord --cwd ~/your/project

# Start
bun cli/hydra.ts up discord
```

## Platform Setup

- **[Discord Setup](docs/discord.md)** — bot creation, token, permissions, pairing
- **[Slack Setup](docs/slack.md)** — app manifest, Socket Mode, tokens

## CLI Reference

All operations go through the `hydra` CLI (`bun cli/hydra.ts` or alias to `hydra`).

### Setup

```bash
hydra install <platform>       # Generate launchd watchdog, run preflight
hydra uninstall <platform>     # Remove launchd watchdog
hydra preflight <platform>     # Verify deployment is ready
```

### Lifecycle

```bash
hydra up <platform>            # Start daemon + byte
hydra down <platform>          # Stop byte + daemon
hydra restart <platform>       # Restart daemon (picks up code changes)
```

### Session Management

```bash
hydra spawn <prompt>           # Spawn a new session
hydra list                     # List active sessions
hydra status <name>            # Session details
hydra kill <name>              # Kill a session
hydra peek [name]              # View live sessions (chooser or direct attach)
hydra health                   # Daemon diagnostics
hydra clear-key <key>          # Clear a stuck idempotency key
```

### Options

```
--daemon <name>                Target a specific daemon (when multiple running)
--json                         Output raw JSON
```

## Configuration

### Bot tokens

Set in `~/.claude/channels/<platform>/.env`:

```bash
# Discord
DISCORD_BOT_TOKEN=MTIz...

# Slack
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
```

### Raindrop observability (opt-in, off by default)

Reports session lifecycle metadata to [Raindrop](https://raindrop.ai) — spawn, reply,
death, and 👍/👎 reactions as sentiment signals. **No message text is ever sent.**

Events go to `/v1/events/track`, the vendor's plain-event endpoint, as a
one-element array. Not `track_partial`: hydra sends no prompt or completion
text, and a finalized partial carrying neither renders as an empty
AI-generation row — the vendor's own Rust and Python SDKs drop that shape
client-side. The price is that the plain endpoint's ingest schema has no
conversation field, so the thread id travels as an ordinary property and
grouping is a filter rather than a built-in conversation view.

Two wire bodies, both in `daemon/raindrop-payload.ts`. An event carries the
event name, your `user_id`, an ISO timestamp, a platform message or session id
as `event_id`, and `properties`: the `SESSION_PROPERTY_KEYS` allowlist
(`tmuxName`, `engine`, `sessionType`, `originType`, `platform`) plus `repo`,
`threadId`, `model` and `replyChars`. A signal carries an `event_id`, a fixed
signal name, a sentiment, and the constant `signal_type`. Nothing else leaves
the machine.

Every property value is shape-checked at the boundary, not trusted from
upstream: 64 identifier characters, and anything else is dropped rather than
sent. Three fields carry a value the calling session or its spawner chose.
`model` is resolved against the model catalogue and dropped if it isn't one.
`repo` is the git project the session's worktree belongs to, capped at 40
identifier characters — which bounds it but does not close it, since a session
that can create directories under `SPAWN_CWD` chooses up to 40 of those bytes.
Set `RAINDROP_OMIT_REPO=1` and the field is never sent; any non-empty value
omits, so the control fails closed. `threadId` is a spawned session's own
thread and, for main, the reply's chat id; it is bounded to 32 identifier
characters plus an optional Slack timestamp rather than closed.

Set in the state-dir `.env` alongside the bot tokens. The daemon reads that
file itself and then removes the four `RAINDROP_` vars from its own
environment, so they are in no command line, no `ps` output, and nothing the
daemon forks — a child started with the daemon's environment would otherwise
carry the key where any process running as you can read it. That is not a
secret from a session that goes looking: the file is `0600` and every session
runs as you, exactly as it already does for the bot tokens.

The spawn boundary scrubs as well, because the CLI reaches `tmuxNewSession()`
on paths that never load the daemon's config. Creating a tmux
*session* goes through `tmuxNewSession()` in `shared/spawn-env.ts` and nothing
else may; spawning codex goes through `codexSpawnEnv()`. Both are enforced by
test. A new *window* in an existing session is not covered and does not need to
be — a window's pane inherits the server environment, which the sweep has
already cleared. `tmuxNewSession()` does two things — it sanitizes the environment handed
to the child, and it sweeps an already-frozen server with `set-environment -gr`
— because a pane inherits the tmux server's environment rather than the
client's. `codexSpawnEnv()` only sanitizes; codex never starts a tmux server,
and a pane it lands in was already swept. On the shell path
`scrub-raindrop.sh` does both halves, sourced by `env-setup.sh` and by
`start-transcribe.sh`. That also means a value
frozen there would outrank both `.env` files. Only the daemon re-reads them,
from the file. Starting the daemon clears them from a server that already holds
a copy.

Three rungs, highest first: the daemon's inherited environment, the repo-root
`.env`, the state-dir `.env` — each only fills what the one above left blank.
So a stray `RAINDROP_` line at the repo root overrides the state dir, including
an explicit `off`. The top rung is not a way in: exporting a `RAINDROP_` var in
your shell does **not** work, because the CLI and `env-setup.sh` both strip them
before the daemon starts — `RAINDROP_MODE=dryrun hydra restart` is a silent
no-op. It has to go in a file.

```bash
# dryrun writes payloads to <state-dir>/raindrop-dryrun.jsonl and sends nothing.
# Over 5MB the oldest lines drop back to a 2MB tail, checked once a minute —
# sample that file, don't archive it.
# Switch to `live` once you've read it and are happy with it.
RAINDROP_MODE=dryrun
# Printable ASCII only. A key that picked up a zero-width space or smart quote
# on the way out of the browser is refused, and hydra health names it. Quote the
# value: env-setup.sh shell-sources this file, and a bare quote inside it aborts
# that source — under watchdog.sh, silently, dropping every var below this line.
RAINDROP_WRITE_KEY="..."
# Any non-empty value omits the field — a misread value withholds data rather
# than sending it. Blank or absent leaves repo names on. hydra health names a
# value that isn't the literal 1.
# RAINDROP_OMIT_REPO=1
# Your own platform user id (Slack U…/Discord snowflake), stamped on EVERY
# session's events. Required once more than one person can drive a session — a
# second allowFrom entry, or any channel group (an empty group allowFrom admits
# every member); until then the module refuses to guess and sends nothing.
# Leave blank rather than guessing: a wrong id attributes every event to a
# stranger, silently.
RAINDROP_USER_ID=
```

Unset `RAINDROP_MODE` means no listeners are registered at all. `live` without a
write key is treated as `off` and logged, never as a silent dry-run. Changes need a
daemon restart.

`hydra health` (CLI and chat) reports the current mode, a running count of
events and signals recorded with how long ago the last one was, whether events are
attributable, whether `RAINDROP_USER_ID` names someone who can actually drive a
session, whether `RAINDROP_OMIT_REPO` was understood, and any failures. **That count is the check after switching to
`live`:** send one message to a session, re-run `hydra health`, and confirm it
went up. Before any traffic a healthy install and a bad key look identical — a
401 only shows once a send has been attempted. A rising count proves the vendor
accepted the POST, not that it landed where you meant: open Raindrop and
confirm the `hydra.session.*` events and thumbs signals appear under the user
id you configured. Note the write key is org-scoped and hydra sends no
`X-Raindrop-Project-Id`, so everything lands in the org's **Production**
project regardless of which project page you copied the key from. The counters reset on restart. The dry-run file is created lazily
— it won't exist until the first session event — so on a fresh enable, check
`hydra health` rather than `ls` — `grep raindrop
~/hydra-<platform>-daemon.log` only confirms registration and names failures,
since nothing is logged per event. It is also append-only across restarts, so an old file is not evidence the
current daemon is writing; check its mtime.

Switching back to `dryrun` stops egress but is not a teardown — the key stays
live on disk, and health will not mention it because a key is expected during a
dry run.

Turning it off stops the reporting, not the whole change: the tmux environment
sweep, `scrub-raindrop.sh`, the capture that strips the four vars from the
daemon's own environment, the `reaction` event, the Discord reaction intent and
the dry-run file's 5MB trim are all unconditional. If the problem is in one of those, this is a revert
and a restart, not an `.env` edit.

To turn it off: remove `RAINDROP_MODE` **and** `RAINDROP_WRITE_KEY` from **both**
the state-dir `.env` and the repo-root one, then restart and confirm `hydra
health` no longer prints a Raindrop line (`raindrop:` on the CLI,
`• Raindrop:` in chat). Both files, because either rung alone re-enables it. A
key left behind is inert but still a live credential on disk.
Delete `<state-dir>/raindrop-dryrun.jsonl` yourself; re-enabling appends to the
existing file. The 5MB trim keeps running from the vitals tick whatever the mode
is, so a dry-run file kept as evidence still loses its oldest lines — copy it
elsewhere if you need it intact. Anything already sent in `live` mode
is at the vendor: deleting it there is your job, not hydra's.

Known limits:

- `hydra.session.death` fires on every `killSession` path — kill, respawn, reap,
  protocol completion, thread `destroy`. A session that *crashes* emits nothing
  at the moment it dies; it only reports when something reclaims the thread.
  Reclaiming in the same daemon does emit, stamped with the crash time rather
  than the reclaim, so duration stays honest. Reclaiming after a daemon restart
  emits nothing at all — the new process never knew the session — so deaths are
  under-counted by the crashed-then-restarted population.
- A daemon restart emits no `hydra.session.spawn` for sessions already alive at that
  moment — they are re-seeded as known. On the very first enable that is every
  session running at the time, so their deaths arrive with no matching spawn. A
  spawn-vs-death funnel will therefore under-count spawns across restarts.
- 👍/👎 signals only attach to replies this daemon process sent, and only the
  most recent 1000 messages — a reply split into chunks uses one slot per chunk,
  so the window is shorter than 1000 replies. Reacting to an older message
  records nothing.
- 👍/👎 need the platform to deliver reaction events: a Slack app needs
  `reaction_added` in its bot events (`docs/slack.md`), and reacting in a Discord
  DM needs the `DirectMessageReactions` intent. Slack needs the manifest updated
  and the app reinstalled; the Discord intent is code-side and non-privileged, so
  a `hydra restart` on this version is enough.
- `model` is the model the session *launched* with, for claude sessions: an
  in-session `/model` switch does not change it, and for main a byte restart
  surfaces within 10 minutes. Codex sessions differ — the app-server reports the
  thread's current model on every daemon boot, so a switch does surface. A model
  outside the catalogue is dropped rather than sent, which reads the same as a
  session that had none.
- Switching to `dryrun`, or a vendor outage, needs a daemon restart to take
  effect — the mode is read once at boot. There is no runtime off switch, and a
  `live` install with an unreachable vendor keeps trying one 5s request per
  event, logging each failure, until you restart it.
- A 👍 then 👎 on the same reply records both, permanently. Signals are not
  retractable and `reaction_removed` is not subscribed; repeating the *same*
  reaction is de-duplicated, changing your mind is not.
- `repo` is present only for a session spawned into a worktree. A plain
  `spawn:` session runs in `SPAWN_CWD` and reports none, so a repo-grouped view
  covers part of the fleet rather than all of it.
- main reports replies only. It has no registry entry, so it produces no spawn
  and no death event.
- `model` is a plain property, not Raindrop's built-in model dimension — that
  dimension is fed from `ai_data`, which this does not send. Filterable, but it
  won't group Events or Costs by model for you.
- Every event carries the one configured `RAINDROP_USER_ID`. On a shared
  install a colleague's session is reported under your id — only their 👍/👎 is
  dropped, not their sessions.
- Headless sessions report nothing — no spawn, reply, or death. They have no
  conversation to attribute, so they are skipped by design and a fleet leaning
  on them exports only its interactive sessions.

#### 🔪 now works in Discord DMs

The intent that carries 👍/👎 also reaches the `:hocho:`/🔪 delete handler,
which could not fire in a Discord DM before. Intended, and gated on the
top-level `allowFrom` as it already was in guilds — but it is a permission
change, and turning Raindrop off does not revert it.

### Access control

`access.json` controls who can message the bot. Lives in the state dir (`~/.claude/channels/discord/` by default).

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

```bash
# Install both
hydra install discord
hydra install slack

# Start both
hydra up discord
hydra up slack
```

Each platform gets its own daemon, state dir, and watchdog. Use different `CLAUDE_CONFIG_DIR` values for separate logins.

### Voice dictation

Hydra can transcribe inbound audio attachments (Discord voice notes, Slack audio
clips) to text, so you can **dictate prompts** to Claude alongside text and images.

Transcription runs in a self-hosted sidecar (`transcribe-server/`) so audio never
leaves your machine. Claude doesn't accept audio natively, so the daemon
transcribes first and merges the text into the message as `[voice transcript] ...`;
the original audio file stays available in `downloaded_files`. Backend by platform:

- **macOS (Apple Silicon)** → **Parakeet-MLX** — NVIDIA Parakeet TDT on Apple's MLX
  runtime. Native, fast (~50× realtime), no GPU/CUDA. _Default on macOS._
- **Linux + NVIDIA GPU** → **Canary-Qwen 2.5B** via NeMo (top of the Open ASR
  leaderboard for English accuracy).

It's **on by default on the daemon side** — whenever a sidecar is reachable, voice
notes are transcribed; when it isn't, audio just passes through. So the only thing
to set up is the sidecar.

**Try it right now (no model install):**

```bash
./start-transcribe.sh mock     # GPU-free stub, returns a canned transcript
```

Send a voice note → Claude receives `[voice transcript] This is a mock transcription...`.
(The mock is manual-only: the daemon never auto-starts it, so a leftover mock
setting can't silently feed canned text into real messages. `hydra down` or
`tmux kill-session -t hydra-transcribe` stops it.)

**Real transcription (one-time; needs ffmpeg — `brew install ffmpeg`):**

```bash
./transcribe-server/setup.sh   # venv + the right backend for your platform
```

That's it. Once set up, the sidecar starts and stays up **with the daemon** —
`hydra up`, `start-daemon.sh`, and the watchdog all bring it along; `hydra down`
stops it. One shared tmux session (`hydra-transcribe`) serves every platform
daemon. Run `./start-transcribe.sh` to start it by hand. Set
`HYDRA_TRANSCRIBE_AUTOSTART=0` to keep the daemon from managing it, or `=1` to
force autostart even before setup (loud failure instead of a quiet skip).

If the sidecar is unreachable, the daemon logs it and delivers the message without a
transcript — dictation never blocks normal messages (a down sidecar fails fast; a
live-but-slow one delays only the voice message itself, up to
`HYDRA_TRANSCRIBE_TIMEOUT_MS`, 60s default). Disable entirely with
`HYDRA_TRANSCRIBE_ENABLED=0`. Full setup, env vars, and tuning:
[`transcribe-server/README.md`](transcribe-server/README.md).

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

Sessions get cute names (spark, pixel, nova...) and run in their own tmux sessions. State persists across daemon restarts.

## Troubleshooting

Symptoms first — each maps to one root cause. See [docs/ONBOARDING_TIPS.md](./docs/ONBOARDING_TIPS.md) for a full first-machine checklist.

**Raindrop is enabled but nothing is being recorded.**

Run `hydra health` — **after restarting the daemon**, which reads its
environment at boot, so an edited `.env` means nothing until then. No Raindrop
line (`raindrop:` on the CLI, `• Raindrop:` in chat), or one reading
`RAINDROP_MODE is off or unset`, means the mode resolved to `off` — either unset everywhere, or an
`off` that outranked your `dryrun`. Check the **repo-root** `.env` first; it
beats the state dir. That same line after a teardown is the reminder that the
write key is still on disk.

"no allowlisted user" means nobody can be identified at all: nobody has paired
yet, or `access.json` was corrupt and got reset (hydra moves it aside and
starts from defaults). If it says "no attributable user", the opposite —
more than one person can
drive a session — most often a channel group with an empty `allowFrom`, which
admits every member — and nothing is sent until `RAINDROP_USER_ID` is set. That
can start happening long after boot, because `access.json` is re-read on every
message. Signals are narrower than events: an event is *attributed* to
`RAINDROP_USER_ID`, so only a reaction from that same id records one. Anyone
else's 👍/👎 is dropped rather than filed as yours, and `hydra health` does not
count it as a failure.

"N send failures" (live) or "N write errors" (dryrun) counts rejected posts,
failed local writes, and any error thrown inside a raindrop listener. Get the
detail from `grep -E 'raindrop: (send|write) failed' ~/hydra-<platform>-daemon.log`
— a 401 is a bad write key. If health shows a normal mode and no failures, the dry-run file is
created lazily and only appears after the first session event.

**Bot is online but a spawned thread stays empty, or `spawn:` does nothing.**
Command interception (`spawn:`, `kill:`, `/sessions`, `/health`) fires only for senders in the **top-level** `access.json` `allowFrom` — separate from a channel group's `allowFrom`. A group lets *replies* through; *commands* need you in the global allowlist. → `/discord:access allow <your-snowflake>`. (The daemon logs `command-shaped message from non-allowlisted sender …` when this happens.)

**Byte or spawned session hangs on a theme picker, login, or "trust this folder" screen.**
The byte is a second, headless Claude in tmux using `CLAUDE_CONFIG_DIR` (default `~/.claude`), so it reads **`$CLAUDE_CONFIG_DIR/.claude.json`** — not `~/.claude.json`. A fresh config dir triggers first-run gates that block a detached session. → Complete them once via `tmux attach -t <platform>-byte`, or pre-seed `theme`, `hasCompletedOnboarding`, `bypassPermissionsModeAccepted`, and per-project `hasTrustDialogAccepted`. `hydra preflight` now flags this.

**Bot connects but never sees inbound (looks healthy, ignores everyone).**
→ Enable **Message Content Intent** (Developer Portal → Bot → Privileged Gateway Intents), or the bot receives empty message content.

**Byte dies instantly, or spawns fail to launch.**
→ Check `SPAWN_CWD` points at a directory that exists. Inspect `~/hydra-<platform>-byte.log` and `~/hydra-<platform>-daemon.log`.

**`usage` shows `?` instead of context percentage.**
Claude Code doesn't display context % in the status bar by default. Add a `statusLine` hook to `$CLAUDE_CONFIG_DIR/settings.json`:
```json
{
  "statusLine": {
    "type": "command",
    "command": "~/.claude/statusline.sh",
    "refreshInterval": 5
  }
}
```
Where `~/.claude/statusline.sh` extracts the percentage from the JSON passed on stdin:
```bash
#!/bin/bash
input=$(cat)
pct=$(echo "$input" | jq -r '.context_window.used_percentage // 0' | cut -d. -f1)
echo "ctx: ${pct}%"
```
The hook receives `context_window.used_percentage`, `model.id`, `cost.total_cost_usd`, and more. Restart the byte to pick up the change.

**Verify inbound end-to-end:** `grep -E "main bridge connected|running tmux new-session" ~/hydra-<platform>-daemon.log`

## Files

| File | Purpose |
|------|---------|
| `gateway.ts` | ChatGateway interface and shared types |
| `discord-gateway.ts` | Discord implementation (discord.js) |
| `slack-gateway.ts` | Slack implementation (@slack/bolt Socket Mode) |
| `daemon.ts` | Platform-agnostic message router and session manager |
| `bridge.ts` | MCP relay between Claude and daemon (unix socket ↔ stdio) |
| `cli/hydra.ts` | CLI entry point — routes commands |
| `cli/helpers.ts` | Config resolution, tmux wrappers, socket comms, compile check |
| `cli/lifecycle.ts` | Lifecycle commands: up/down/restart/watchdog/preflight/install |
| `cli/peek.ts` | View live sessions via tmux linked windows with filtered chooser |

Logs land at `~/hydra-<platform>-daemon.log` and `~/hydra-<platform>-byte.log`.
