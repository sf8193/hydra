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
claude plugin install discord@claude-plugins-official

# Create .env with your bot token and an existing working directory
mkdir -p ~/.claude/channels/discord
cat > ~/.claude/channels/discord/.env << 'EOF'
CHAT_PLATFORM=discord
DISCORD_BOT_TOKEN=your-token-here
SPAWN_CWD=~/your/project
EOF

# Run `claude` once: accept the onboarding screens and log in

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

The watchdog runs every 120s. It restarts the daemon when its tmux session is gone, when its heartbeat is more than 300s stale, or when it is spinning: 90% or more of a CPU core over the interval since the previous tick, two ticks in a row, the same definition the vitals tick uses for bridges and Claude (an event loop spinning in place starves its own timers, so the daemon can't catch this itself). The stale-heartbeat and CPU restarts wait while the platform's API is unreachable. Each restart is logged in `~/hydra-watchdog.log`. The third restart within an hour also sends you a DM listing them (or posts in the default channel if no one is allowlisted). The daemon sends it once it is connected again, since the watchdog has no chat connection of its own. A loop that keeps going is reported again about once an hour. An alert that waited more than an hour for a daemon to send it says how old it is.

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

Four homes, each for one kind of fact. A fact lives in exactly one of them.

| Where | Holds | Who writes it |
|---|---|---|
| `<state dir>/.env` | **how the daemon runs**: `SPAWN_CWD`, `HYDRA_MODEL`, bot tokens | you |
| `<state dir>/hydra.toml` | **whom it serves**: the operator, people and roles, connectors, specialists and where they listen, schedules, rules, the guard | you; hydra re-reads it within a second of a change |
| `<state dir>/` state files (`sessions.json`, `threads.json`, `specialist-threads.json`, `jobs-state/`, `idempotency.json`, …) | **what it remembers** | hydra only; never edit by hand |
| a specialist's `workdir` | **what the agent knows**: its `CLAUDE.md`, `AGENTS.md`, skills and files | you and the agent; hydra never reads it |

The state dir is `~/.claude/channels/<platform>/` by default. Every `hydra.toml` key, with a one-line comment each, is in [`hydra.example.toml`](hydra.example.toml); a test loads it, so it stays current. To start from an existing install (`access.json`'s `allowFrom`, `specialists.json`, `slack-watch.json`), stop the daemon and run `hydra migrate <platform>` (`--dry-run` first shows what it would write). It keeps every file it changes as `*.migrated`, and an interrupted run is finished by running it again. A daemon refuses to start while `hydra.toml` sits beside old state it replaces, and says why in its log and in `hydra health`.

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
# session's events. Required once the top-level allowFrom has more than one
# entry; until then the module refuses to guess and sends nothing. On Slack,
# channel groups are skipped rather than counted; on Discord any group stops
# recording entirely.
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

#### 🔪 now works in Discord DMs

The intent that carries 👍/👎 also reaches the `:hocho:`/🔪 delete handler,
which could not fire in a Discord DM before. Intended, and gated on the
top-level `allowFrom` as it already was in guilds — but it is a permission
change, and turning Raindrop off does not revert it.

### Access control

`access.json` controls who can message the bot. Lives in the state dir (`~/.claude/channels/discord/` by default). Once `hydra.toml` exists, its `operator` replaces `allowFrom` (admin checks, DMs to main) and pairing is off; the rest of `access.json` (DM policy, groups) still applies.

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

### Idle reaping

An ephemeral session (`hydra spawn --ephemeral`, and every `jobs.toml` spawn) is nudged after 30 minutes with no one posting in its thread (`--idle-ttl` / `idle_ttl` sets its own, up to 7d), then ended 5 minutes later unless someone replies.

`HYDRA_IDLE_REAP_DAYS=<days>` in the state dir's `.env` (off by default; a positive number such as `7` or `1.5`; a change takes a restart) does the same for every other spawned session idle that long. Exempt: byte, thread guests, a specialist's session and any session in a protocol run.

- **Idle** means nothing was delivered to it, it called no Hydra tool (`reply`, `send_to_thread`, …), and it isn't busy at that moment: working, blocked at a permission or plan prompt, or running a background shell.
- **A fresh window instead** goes to a session that is busy, has a live session it spawned, or has a message from a person in its thread newer than its last reply there. It isn't ended before it answers, or while a child may still report to it.
- **Ended the way a crash leaves a session:** its record, worktree, scratchpads and PR watches are kept, and automatic recovery at the next daemon start skips it. The nudge, the thread notice and the closing message all say how to come back: typing `resume` in the thread continues the conversation.
- **The first start with the setting** gives every session a fresh window, so nothing is ended at once.

### PR watching

`watch [pr-url]` in a session thread watches a PR (no URL: the PR for the session's current branch). The daemon polls every 3 minutes and delivers new review feedback and CI failures to the session. `unwatch <pr-url>` stops; `watches` lists them.

Add `+green` (`watch <pr-url> +green`, or `watch_pr` with `notify_green: true`) to also post `✅ CI green` in the thread when CI passes, once per head commit. It is a plain thread message, not a session turn. Using it on an already-watched PR turns it on for that watch; `watches` marks these with 🟢.

### Specialists

Once `hydra.toml` exists, it declares the specialists (`[specialists.<name>]`, see [`hydra.example.toml`](hydra.example.toml)) and `hydra specialist set` only moves `--thread`; the commands below describe an install that hasn't migrated.

A specialist is a standing job with a stable name, filled by one long-lived session. It stores the thread its session lives in (or the channel to open one in) and the prompt to start it with, and it is the only pointer to that thread: the session is named after the specialist, and only the specialist claims that name, under its own lock. Its name needs a letter (an all-digit one reads as a thread id) and must not be one of the default session names (spark, comet, …); a name stored before that rule is reported at boot and ignored, never renamed.

| Step | Command | What happens |
|---|---|---|
| Declare | `hydra specialist set <name> [--channel <id>] [--thread <id>] [--kickoff <text> \| --kickoff-file <path>] [--model <id>] [--idle <30m\|4h\|1d>]` | Creates or updates it; fields you leave out keep their value. A new one needs `--channel` (its first session opens a thread there) or `--thread` (an existing one). `--idle` ends a quiet session: nudged, then reaped. Moving a live specialist to another `--thread` is refused (exit 3): two sessions never answer to one name, so kill it first. |
| Create | `hydra spawn --specialist <name> --initiator <who> --idempotency-key <key>`, or the first delivery | Spawns the session for the declared specialist: its kickoff is the prompt, its channel and model are the spawn's, the session is named `<name>`. Takes no prompt. If the specialist is already filled it refuses with exit 3 naming the occupant, and an operator's spawn is not held back by the refill back-off. |
| Deliver | `hydra deliver --to <name> --message "..."` (also `--specialist <name>`; `send_to_thread(target="<name>")` from a session; the Slack listener in-process) | Whispers to the live session; if nobody is home, fills the specialist first (one spawn, however many callers arrive together), then delivers. A session stuck on a dialog or prompt is not delivered into (exit 5, "stuck: …"). |
| Look | `hydra specialist show <name>` / `list` | The stored fields plus who fills it now and whether refills are backing off. `hydra peek\|attach\|kill\|status <name>` take a specialist's name, a session's name, or a thread id. |
| Change | `hydra specialist set <name> --kickoff-file … --model …` | Applies at the next refill; to apply now, `hydra kill <name>` then `hydra spawn --specialist <name> …`. |
| Retire | `hydra specialist rm <name>` | Removes the declaration; a running session is left alone. |

`hydra deliver --to` resolves in order: `main`, a declared specialist, an all-digit thread id (`--revive` heals a dead one); anything else is exit 8, `no such specialist`. In-process senders (jobs, Slack, PR watch) use the same targets through `daemon/targets.ts`, which also takes a recipe instead of a name: `spawn` (a fresh session for every message) or `perThread` (one specialist per Slack thread, named from its key and never stored).

A handoff successor keeps its predecessor's name and thread, so it keeps filling the specialist. A refill runs the same cascade as `resume`: it resumes the dead session's conversation in the specialist's thread, else forks it, else starts a fresh session there from the kickoff that reads the thread first. The kickoff file is read only for that last step, and re-read every time. The thread is reused while the platform still has it; only a definitive "gone" from the platform opens a new thread in its `--channel` (as does a specialist that never had one), and that session is told its old thread is gone. A refill that keeps failing backs off (30s, doubling to 10 minutes; callers get exit 6 with the last error); the back-off is kept in `<state>/revive-backoff.json`, survives a restart, clears on success or `specialist rm`, and shows in `specialist show`. An occupant that is running with no bridge connected for more than 90 seconds is reported orphaned (exit 4), never refilled over.

### Slack: routing from hydra.toml

Slack is one connector of [routing](diagrams/flow-route.mmd): who sent a message and where decide which specialist hears it, all from `<state>/hydra.toml` ([Configuration](#configuration); every key in [`hydra.example.toml`](hydra.example.toml)): `[connectors.slack]` for the tokens, a specialist's `listens` for the places it answers, `allow` for the roles that may reach it. Routing is content-blind: it never reads what a message says.

**Where a message goes.** A conversation is a Slack thread, or a DM's top level. It is bound to a specialist when its first message arrives: by the first `[[rules]]` entry at that place that matches the sender, else by the specialist that `listens` there (a channel's id outranks its name), else, for the operator's DM, `main`. Everything later in it, owed messages included, follows the binding: a config change re-routes only new conversations, a rename through `was` keeps them, and a conversation whose specialist is no longer declared is routed anew. `hydra conversations bind <conversation> <specialist>` moves one; `hydra route --as <person> --at <place>` prints every candidate and why the winner won. A message that tags the bot, or a DM, opens a conversation; every later reply in it reaches the specialist, tagged or not, until it has been idle a week. Where `[places]` says `listen = "all"`, an untagged top-level message opens a conversation too: its own thread, bound to wherever that message routed (so one person's message never captures the place, and replies under it follow its binding). Conversations opened by untagged chatter go after a day idle rather than a week; while still owed or answered (a reply under them) they may take only half the conversation table, and once delivered and unanswered they hold no slot at all, so a busy place keeps being heard.

**Who may reach it.** `allow` is checked when a message arrives and again when it is delivered, so taking a role away refuses at once. The operator reaches every specialist; `main` hears only the operator; `people` is everyone on the roster and `anyone` admits strangers. A mention or DM that is refused, or that no specialist hears, gets a 🚫 reaction (capped per sender like tags; past the cap, logged and counted only) and is counted, before anything is bound, owed or counted against the tag cap; ambient chatter never does. A message accepted and then unable to go anywhere (its sender's role taken away while it waited, or its specialist removed with nobody else hearing the place) is a counted, alerted drop. Hydra's notices to senders are reactions, never prose.

**Replies.** A specialist answers with `reply`, passing the delivery's `conversation` as `chat_id` (`slack:C0ABC:1793732224.093059`, or `slack:D0ABC` for a DM). Hydra posts the text as written, into that thread (or the top level it came from), split under Slack's 4,000-character advice, and only when the conversation is bound to the caller's specialist (`main` for the operator's DMs): a reply goes back where its question came from, and nowhere else. A specialist may also post to its own `home` when that is a Slack place (`reply` with `chat_id` = the home as hydra.toml writes it, or `slack:<channel id>`): a schedule's reply has no conversation. It goes as a new top-level message, any further parts in its thread, and that thread is bound to the specialist so answers come back to it. A home thread counts with the conversations a specialist binds by hand (at most 10); past that the post goes, unbound, and the operator is alerted. Authority is checked again before each part, so a conversation moved away mid-reply gets no more of it. Posting never retries on its own and gives up after 30 s: a part with no answer is reported as unknown (it may have posted), never silently resent. A conversation that has gone idle can't be answered; attachments aren't posted yet.

**One session per conversation.** A specialist with `sessions = "per-conversation"` gives each conversation its own session, named `<specialist>_<conversation>` (`crm_c0abc-1793732224-093059`; the `_` is a character no specialist name may hold), made from the specialist's own recipe (its channel, or its thread's channel; its kickoff, model, and `idle`, else hydra.toml's) in a fresh thread, and never stored: what one asker says is never in another's memory. At most `max` (default 20) run at once, counted from the sessions running under the specialist's names (old ones through `was` too); a conversation past that waits, its messages owed and kept past the usual day while they wait (alerted once an hour while it lasts); when places are short, waiters are served first come, first served; when one of the specialist's conversation sessions ends (killed, reaped, or found dead), catch-up offers the oldest waiter its place at once; a waiter whose thread can no longer be read is dropped, and no wait lasts past three days (then its messages are dropped, alerted), so give such a specialist an `idle`. A start in progress holds its place, and only the decision takes the specialist's lock: a slow start holds up no other conversation. A conversation session acts for its specialist (its tools, its `home`), but answers only its own conversation. A rename keeps each conversation in the session it runs in. A conversation's own session answers that conversation and no other.

**What the specialist reads.** Each delivery is other people's words inside a nonce-marked envelope, never instructions. Where it was said rides on the opening marker (`place`, `conversation`, `link`), and who said each message rides on its header line as attributes (`person`, `roles`, `operator`, `address`, `name`), from hydra.toml, never as text the sender could fake; a stranger's Slack display name is cleaned of mentions. Messages close together are coalesced; long ones are cut and split to stay under the deliver cap.

A message is *owed* from the moment it is accepted until a delivery lands, and that is written to `<state>/slack-watches.json` before anything is sent, so a restart cannot lose it; what was delivered is remembered exactly, so a replay never delivers twice. **DMs, files, ack.** A DM needs no tag; a DM conversation's top-level messages are one conversation (a thread inside a DM is its own), delivered as `[dm …]` items. A refused DM leaves nothing behind, and a conversation quiet past a week is forgotten. `[places]` `files = true` downloads each message's attachments to `<state>/slack-files/<channel>/<file id>-<name>` at mode 0600 (directories 0700), streamed to disk, one download per file however many messages share it, kept for a week, and lists the paths in the delivery; a file over 20 MB, a failed download, a file Slack gives no download link for, or a place without `files` is listed by name with why, and the message is delivered either way. Files are fetched only for messages the guard lets through. `ack = "eyes"` adds that reaction to each message once it is delivered. Catch-up scans the history of every DM conversation it knows of, and with `im:read` lists the bot's DMs, so a conversation opened while the listener was down is found (read back a day) when its sender's DM would be delivered. A pass reads channels, then DM conversations, then threads; DMs take what the budget leaves, least recently read first, and a DM a pass could not reach keeps its cursor held until one reads it.

**`[guard]`** is your own command, run for each message from anyone but the operator after routing and the allow check: `command`, `timeout` (default `5s`, at most 30 s), `include_text`, `owed_max` (default `1h`). Its stdin is `{person, roles, place, conversation, to}` (plus `text` with `include_text`). Exit 0 delivers; printing `{"to": "x"}` redirects that message (not the conversation), and `x`'s `allow` is checked again; a redirect it refuses, or to no declared specialist (alerted once per episode), goes to the binding instead. Exit 10 drops (counted, not alerted). Exit 75 keeps it owed and the next catch-up pass offers it again, for at most `owed_max` from the first "not now", then it is dropped as `expired`. Anything else, a timeout, too much output or a command that will not start delivers anyway and is logged: a broken guard never silences anyone. It runs in its own process group with an allowlisted environment and a 4 KB stdout cap.

Nothing is dropped silently: a message dropped because it stayed owed past a day (`expired`), more than 200 were owed in its thread (`owed-full`), it can never fit a delivery (`too-large`), its sender opened too many conversations in ten minutes (`tag-cap`), the conversation table is full (`table-full`), or catch-up had to skip part of a very busy channel (`catch-up-gap`) is logged, counted by kind, and alerted in the thread of the specialist it concerns once per episode: an episode runs an hour from its first drop, per kind and specialist. Unbinding a conversation that still owed messages drops them (`unbound`, alerted). `hydra conversations` is the operator view, and `hydra health` → `slack` shows the conversation count, the age of the oldest owed message, and the refusal, unrouted and drop counts. A session in a specialist declared in hydra.toml gets `bind_conversation` / `unbind_conversation`, for threads in channels it `listens` on (never a DM or a top level, never one bound elsewhere, at most 10 bound by its own hand), and `list_watches` shows it the conversations bound to it. Flow: [`diagrams/flow-slack-route.mmd`](diagrams/flow-slack-route.mmd).

**The listener.** `[connectors.slack]` names the variables holding the app token (`xapp-…`, scope `connections:write`) and the bot token (`xoxb-…`, scopes `channels:history` or `groups:history`, `channels:read` or `groups:read` for `slack:#name` places, `users:read`, `reactions:write` for the ack and 🚫, `chat:write` for replies, plus `im:history` and `im:read` for DMs, `files:read` for files). Only `SLOPBOT_SLACK_APP_TOKEN` and `SLOPBOT_SLACK_BOT_TOKEN` are accepted: they are scrubbed from every session's environment, and a token in any other variable would reach them all, so another name is refused with a log line. At connect the daemon reads its own ids and workspace from `auth.test`, channel names from `conversations.list` (refreshed each catch-up pass and on `channel_rename`; without the scope, places named by id still work, and the missing scope is logged once), logs the scopes each enabled option needs, and warns for each the token lacks. It opens one Socket Mode connection (after boot recovery); its writes are reactions and the specialists' replies. The Slack app needs the `message.channels` bot event (and `message.im` for DMs), and the bot must be in the channel. Nothing else should hold a Socket Mode connection on the same app: Slack splits events between connections.

**Catch-up.** Slack replays nothing missed while disconnected, so a pass reads channel history plus every owed and watched thread, and hands what it finds to the same `handle()` path (dedup keeps replays from delivering twice). It runs after boot, after every reconnect, and every 10 minutes (deep). It is serial and capped at `max(60, 2 × conversations + DM conversations + 20)` API calls, never over 400 (the Slack SDK waits out `Retry-After`); an incomplete pass holds the cursors and retries after 60 s. Every cursor is held from before the connection opens until a pass has read that channel, so a live message cannot move a cursor past the gap; only channel history moves a channel's cursor, never a thread reply. A channel with more than five pages (about 1,000 messages) since its cursor does not fail the pass: catch-up reads the newest five pages, moves on, and surfaces what it skipped as a `catch-up-gap` drop. It recovers channel messages since the cursor, replies in open conversations, and replies in threads that began during the gap. It cannot recover a tagged reply, posted while disconnected, in an older thread no conversation was open in: Slack offers no cheap way to list those.

**Health and alerts.** `hydra health` → `slack.listener` shows `state` (`off`, `connecting`, `up`, `down`, `exhausted`), `downMin`, the last catch-up (`ok`, `accepted`, `reason`) and the age of the last complete one. A failing listener degrades; it never takes the Discord daemon down. At connect the daemon logs which scopes the bot token has (`daemon: slack listener: bot token scopes: …`), and warns when it has neither `channels:history` nor `groups:history`. A Slack refusal that retrying cannot fix (`missing_scope`, naming the scope needed and the ones the token has; `invalid_auth`; `not_in_channel`) is alerted once, at once, in the specialist's thread with what to do, and re-armed by the next complete pass. The specialist's thread gets a plain message, once per episode, when the listener has been down 5 minutes, when catch-up has not completed for 25 minutes, and when the listener is back. A periodic pass that finds messages with no reconnect since the previous pass also alerts (at most hourly): the live stream is losing events, most likely because another process holds a connection on the app; nothing is lost, it arrives up to 10 minutes late.

**Runbook.** Silent in the channel: `hydra health`; `state: up` with `catchUp.accepted > 0` pass after pass means a second connection holds the app. `exhausted`: check both tokens and the app's Socket Mode setting. Catch-up `reason` mentions a budget or rate limit: the next pass resumes from the held cursor. A start-up log line `slack listener off (…)` names what is missing. A first connection that fails is retried with backoff (10 s doubling to 5 min) until it connects, then a catch-up pass runs.

### Schedules (formerly jobs)

A schedule is a clock that sends a message to a specialist. It's declared in `<state>/hydra.toml` under `[schedules.<id>]`: `cron` (5 fields, local time), `to` (a specialist, or `main`; none makes it a sensor), `prompt`, and an optional `check` script whose output is appended (empty output sends nothing). See `signal-routing.md`'s `[schedules.<id>]`. A schedule's message carries the operator's authority; a failure alerts the operator. A run to a `sessions = "per-conversation"` specialist opens a new conversation for that slot: a fresh session in a new thread in the specialist's home, run as `jobs:<id>`.

```toml
[schedules.ledger-review]
cron = "0 11 * * FRI"
runner = "daemon"
needs = ["internet"]
check = "~/ledger/review-check.sh"
to = "ledger-review"        # a per-conversation specialist: each run, a fresh session in a new thread
```

**`<state>/jobs.toml` keeps running exactly as before until `hydra migrate` moves it** (start from [`jobs.example.toml`](jobs.example.toml)). Its jobs become `[schedules]`, a spawn job becomes a per-conversation specialist, and the file is kept as `jobs.toml.migrated`. Each schedule keeps its job's id, so its record (`jobs-state/<id>.state.json`), its covered slots and its launchd entry carry over. The migrate dry run shows each schedule's next slot, whether one is owed, its runner, where it goes and as whom.

`hydra schedules sync <platform>` has the daemon load them now and registers launchd ones; the daemon also re-registers them whenever hydra.toml changes. `schedules list` shows each one's runner, next run and last result; `schedules run <platform> <name>` runs one now; `schedules mark-done` covers a daemon schedule's slot without running it. `hydra jobs …` is the same command, for now.

**A job's `runner` decides what triggers it; delivery to a session is always the daemon's.** Both are on time when all is well. They differ only when something fails:

| | `launchd` (default) | `daemon` |
|---|---|---|
| Depends on hydra running? | no | yes |
| After a failure | one shot: the next slot tries again | keeps trying until done |

In one line: **launchd tries once, no matter what. daemon keeps trying, as long as hydra runs.** Set `runner` at the top of the file for every job, or on a job to override that. With neither, it's `launchd`.

Take a weekly job, `weekly-review`, due Friday 11:00:

| On Friday at 11:00… | `launchd` | `daemon` |
|---|---|---|
| the lid is shut until 14:00 | runs at 14:00 on wake, once | runs at 14:00 on wake, once |
| Wi-Fi is down | runs, fails, and is gone until next Friday | waits (`needs = ["internet"]`), and runs when you're back online |
| the check hits an API error | fails, alerts, and is gone until next Friday | retries with back-off; you're told only if it's still failing after `alert_after` |
| the hydra daemon is down | the check runs at 11:00; its output is delivered once hydra is back | waits for the watchdog to restart hydra (~5 min), then runs |
| bun was just upgraded | keeps working | keeps working |

- **Pick `daemon`** for obligations: a review that has to happen this week, a backup that has to succeed eventually.
- **Pick `launchd`** for keepalives and probes, where the next run makes up for a missed one, or for anything that must run while hydra itself is broken.

A launchd job's entry is registered by `jobs sync` and runs a stable bun link, never a versioned Cellar path, which `brew upgrade` deletes. `needs` and `alert_after` need `runner = "daemon"`.

**Nothing changes unless you opt in.** An existing file runs under launchd as before. The old runner's entries keep working until `jobs sync` moves them onto the stable bun path, and `jobs list` flags any that remain. `jobs sync` registers and unregisters launchd entries only for the platform's live state dir, and removes one only when its job leaves the file or moves to `runner = "daemon"`.

Known and accepted for daemon-runner jobs: in the hour the clocks fall back, a frequent job (`*/5`) pauses for about an hour, once a year. Flows: [`flow-jobs-dispatch.mmd`](diagrams/flow-jobs-dispatch.mmd) (a daemon-runner slot), [`flow-jobs-launchd.mmd`](diagrams/flow-jobs-launchd.mmd) (a launchd-runner slot), [`flow-jobs-sync.mmd`](diagrams/flow-jobs-sync.mmd).

### Usage alerts

The daemon posts account-wide Claude rate-limit alerts to the default channel: the 5-hour window at 80% and 95%, the weekly window at 80%, 90% and 95%, once per threshold. They re-arm when the window resets, or when usage falls well below the last alert. The figures come from Claude Code itself: the hydra mod (`mod/`) in byte reports each change through the main-only `report_usage` tool. Byte's footer ("You've used N% of your weekly limit") is a fallback for the weekly window while the mod is not reporting; both feed one dedupe (`daemon/usage-alerts.ts`), persisted in the state dir so a restart does not re-alert.

### Handoff

`handoff [model][: note]` in a session thread asks the live session to write a handoff file and call the `handoff` tool. A fresh session then continues in the same thread, worktree, and label, optionally on another model.

A note goes after a colon: `handoff: watch the open PRs and refine them`, or `handoff opus: …`. A spaced dash (`handoff - …`, `-`, `–` or `—`) works too.

- **Both sides get it.** The outgoing session is asked to carry it into Next action. The successor's prompt quotes it word for word, so it arrives even if the handoff file leaves it out.
- **You see what happened.** The thread notice echoes it (`Note to pass on: …`), and the `handed off` message says whether the successor got it.
- **It belongs to one request.** The note reaches only the successor of the letter that request asked for. If the session writes a different letter, the note is dropped and the `handed off` message says so.
- **Chat stays chat.** Chat that merely starts with the word (`handoff-related bug`, `handoff looks broken`) is never a command. A line that looks like an attempt but doesn't parse (`handoff -- x`, or a non-model word before the colon, `handoff status: x`) also goes to the session as chat, and the daemon replies with the command's form.
- A local `departing.md` must include `{{note}}`, or the outgoing session never sees the note. The successor still does.

Four optional files in the state dir customize what each side is told. All are re-read each time they are used, so edits apply without a restart:

- `actions/handoff/departing.md` **replaces** what the outgoing session is told. It must tell the session to write the file and call the `handoff` tool with `path=` (usually `{{artifact}}`). Nothing enforces this, so a template that omits it never hands off.
- `actions/handoff/arriving.md` is inserted after the read-your-handoff line and **replaces** the built-in arrival behavior (the Reception note, the greeting's content, starting the Next action at once). Thread ids, the greeting itself, the description and the fork recipe stay.
- `actions/handoff/notice.md` **replaces** the message the thread sees when the handoff is requested. Useful when your departing steps take longer than the built-in ones, so the advice on when the session looks stuck should change too.
- `actions/handoff/converge.md` **replaces** the converge nudge (below). Its placeholders are `pct` (the session's context now), `then` (the built-in text's last sentence on when to hand off: at the full-handoff line; the next time it is idle when it is already past that line, or at the next natural break if it was already asked there; or at the next natural break when that handoff is off), `full` (the full-handoff line, empty when that handoff is off) and `session`.

`{{name}}` placeholders are filled per handoff:

| Placeholder | departing, notice | arriving |
|---|---|---|
| `artifact` | ✓ | ✓ |
| `session` | ✓ (outgoing) | ✓ (successor) |
| `requester` | ✓ | |
| `model` | ✓ | |
| `cwd` | ✓ | ✓ |
| `worktree` | ✓ | ✓ |
| `branch` | ✓ | ✓ |
| `label` | ✓ | |
| `note` | ✓ | ✓ |
| `from` | | ✓ |
| `from_session` | | ✓ |
| `from_transcript` | | ✓ |

`from_session` is the predecessor's Claude session id and `from_transcript` its transcript path. Each is empty when unknown, and always for a Codex predecessor. `note` is empty when the command had none. Unknown placeholders are left as written. A missing file uses the built-in text. An empty or unreadable one does too, and the daemon logs a one-time warning.

#### Automatic handoff

Off by default. Each is set in the state dir's `.env`, which the daemon reads at startup, so a change takes a restart; the 5-minute health poll notices a session crossing a line within 5 minutes. A percent is a whole number 1–99; anything else turns the converge nudge off and keeps the full handoff at 85.

- `AUTO_CONVERGE_PCT=<percent>`: when a session's context reaches this, it is told once to start converging toward a handoff: finish or park side work, and write down what it learned where its successor will read it. It is told, not asked to hand off, so it may be mid-task, and only a session owner with a connected bridge and no protocol run is told. It is told again after its context drops below the line and climbs back, and after a daemon restart. It isn't told if it has already been asked to hand off automatically since its context reached the line. A session that starts above the line, such as a fork, is told on the first poll.
- `AUTO_HANDOFF_FULL=1`: an idle session at 85%+ context is asked to hand off, exactly as if `handoff` had been typed, before it is too full to answer anything. `AUTO_HANDOFF_FULL_PCT=<percent>` moves the line.
- `HYDRA_TYPED_DELIVERY_USER_IDS=<id>,<id>` and `HYDRA_TYPED_DELIVERY_MODE=off|paste|hold` (default `off`; an unknown value is `off` and logged once): how a trusted sender's messages reach a Claude session. Claude Code wraps a channel notification that is absorbed into a running turn as "A message arrived from <server> while you were working ... IMPORTANT: This is NOT from your user" (hard-coded in the binary), and sessions then decline the sender's instructions. A notification delivered to an idle session is passed through bare, and text typed into the pane mid-turn is framed as "The user sent a new message while you were working"; neither carries the warning. Idle sessions always keep the channel path. For a session that is mid-turn ("working" is `isSessionWorkingAsync`: Claude's status file, tmux activity as fallback): `paste` types the message into the pane at once, prefixed `[Discord · <user> · msg <id> · thread <chat_id>] ` (so `reply_to` works and a leading `/` or `!` is never a command; attachment paths appended); `hold` keeps it in a per-session queue (bound 20) and sends it through the channel when the session goes idle, checked on the reply guard's existing 20s tick. `HYDRA_TYPED_DELIVERY_HOLD_MAX_S` (default 120) caps a hold: past it the message is pasted instead; a full queue pastes immediately; a dead session's queue is flushed through the channel. Every failure (dialog or permission prompt on screen, tmux error) falls back to the channel, so nothing is dropped; a wrong idle reading only brings the warning. List only people whose word you would type yourself.
- `AUTO_HANDOFF_CACHE=1`: a Claude session at 50%+ context that nobody has touched for 50 minutes is asked to hand off while its prompt cache is still warm.

Only session owners with a connected bridge, no protocol run and no pending permission are asked to hand off; a request unanswered after 3 minutes is repeated once. For example, `AUTO_CONVERGE_PCT=50`, `AUTO_HANDOFF_FULL=1` and `AUTO_HANDOFF_FULL_PCT=70` nudge at 50% and hand off at 70%.

`hooks/on-kill` in the state dir already runs on a handoff, with `HYDRA_KILL_REASON='handed off'`. Use it for post-handoff work nobody waits on.

`hooks/pre-handoff` in the state dir runs before a handoff, and can refuse it. A handoff can't be undone once it starts, so this is the place to check your own definition of done. If the file exists and is executable, the `handoff` tool runs it and waits:

- The letter path is the first argument, always absolute (a relative path from the session is resolved against the session's directory). The env has the same `HYDRA_*` identity vars as `on-kill`, plus `HYDRA_CWD`: the session's worktree, or its working directory. The hook runs in that directory. If the directory is gone or unknown, the hook runs from the temp dir with `HYDRA_CWD` empty, so a `git` check can tell rather than judge the wrong repo.
- Exit 0 and the handoff goes ahead.
- Any other exit refuses it, and the refusal repeats on every retry until the cause is fixed, so make the message say what to fix. The session is not killed. It gets an error that starts `handoff refused by hooks/pre-handoff:`, followed by the last 1500 characters of the hook's output.
- No verdict means the handoff goes ahead: the hook runs past 15 seconds (its whole process group is killed), can't start, dies from a signal, or exits 126 or 127 (it couldn't run a command it needed). A broken script never traps a session.
- Every run of the hook logs one daemon line with the outcome (`pass`, `refused` or `fail-open`), the exit code, the duration, and for a fail-open the reason, e.g. `daemon: pre-handoff hook flint: fail-open, exit 127, 41ms (the hook could not run a command)`. No hook file logs nothing; a non-executable one logs only its "skipped" warning; a gone session dir adds one line saying so before the run.
- A file that isn't executable is skipped with a warning.

For example, to refuse letters with no Next action:

```sh
#!/bin/sh
grep -q '^#* *Next action' "$1" || { echo "letter has no Next action heading"; exit 1; }
```

### Forking sessions

`spawn_session` can start from a copy of another Claude session's conversation instead of from scratch:

- `fork_from="<name>"` forks the session that ran under that name, alive or ended — never a later session that took over its thread. `fork_from="predecessor"` forks the session the caller took over from by handoff. The fork launches in the directory its source launched from, on its source's model unless `model` is given. The source is not touched.
- `read_only=true` blocks Edit, Write and NotebookEdit. Bash stays available, so it is a guard, not a sandbox. A resume keeps it; a handoff successor starts without it.
- Codex sessions can't be forked yet: a fork would need the source's `CODEX_HOME`, and launching there restarts the source's app-server.

To ask the session you took over from a question only it can answer, a handoff successor has `ask_predecessor({ question })`. It runs one turn on a fork of the predecessor's conversation and returns the answer as the tool result, without creating a session, thread or bridge. For Claude that's `claude --resume <id> --fork-session -p` in plan mode, limited to Read, Grep and Glob, with no MCP servers and no session persistence: the fork can't reach Hydra or change anything, and it leaves no transcript.

Each call re-reads the predecessor's whole context, so it costs one full-context turn; it gives up after 180s, and a session runs one at a time. Claude prunes old transcripts (`cleanupPeriodDays`), so after about a month the tool reports that the conversation is gone.

The tool appears only where it works: the predecessor's engine can fork it one-shot (today only Claude), and the successor's client waits long enough (today only Claude's bridge; Codex's MCP client stops at its default `tool_timeout_sec` of 60s, omp's bridge at a fixed 60s). A Codex or omp successor of a Claude predecessor uses the spawned fork below instead; a Codex predecessor can't be forked either way yet.

For a question that needs more than one turn, spawn a fork session instead:

```
spawn_session(fork_from="predecessor", read_only=true, phase_budget="5m", topic="<question>; reply with send_to_thread(target=\"parent\", type=\"result\")")
```

The fork gets its own thread, answers with `send_to_thread(type="result")`, and is reaped at its `phase_budget`. Each fork is a full session boot that loads its source's whole context, so it takes seconds and costs that context's tokens.

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
starts from defaults). If it says "no attributable user", the opposite — the
top-level `allowFrom` has more than one id — and nothing is sent until
`RAINDROP_USER_ID` is set. Channel groups don't count: on Slack their sessions
and replies are skipped and health says how many group channels that covers; on
Discord, where a thread id doesn't name its channel, any group stops recording
and health says so. That
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

**A spawned session runs but its bridge never connects (no `plugin:discord:discord` lines in its debug log).**
Claude Code keeps `$CLAUDE_CONFIG_DIR/mcp-needs-auth-cache.json`, and while it holds an entry for a server (~15 min) every new Claude process sharing that config dir skips the server silently. The daemon removes the bridge's own entry before every launch it makes and logs `cleared Claude Code needs-auth cache entry for plugin:discord:discord (set Nm ago) before launching <name>`; a session that still ends up bridgeless says "Claude Code had the bridge marked needs-auth (cleared at launch)" in its thread. The byte is launched outside the daemon, so if the byte is the one without a bridge, delete that key by hand and restart it.

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

The daemon reads only the footer below the input box, and recognizes two shapes there: `ctx: N%` (above) or a progress bar followed by `N%` (e.g. `█████░░░░░ 54%`, as the GSD statusline renders). Percentages anywhere else on screen — conversation text, Claude Code's own "Context left until auto-compact" line (which counts *remaining*) — are ignored. Whatever number your statusline prints is the one `usage` shows and the 70% context alert compares against; a statusline that rescales (GSD maps the auto-compact point to 100%) moves the alert with it.

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
