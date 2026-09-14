---
name: hydra-cli
description: Use when spawning sessions or delivering messages via the hydra CLI, orchestrating multi-session work, or using hydra programmatically. Triggers on "hydra spawn", "hydra deliver", "use hydra to", "spin up a session", "spawn via CLI", "nudge a session", "send a message to a session", or any request to programmatically create/manage/message hydra sessions.
---

# Hydra CLI

The machine channel into the hydra daemon — the same primitives as chat commands, but for automation. A CLI spawn creates the same thread, session, and lifecycle as typing `spawn:` in chat. Not a parallel world — a different door into the same room.

## When to Use What

| You are... | Use |
|-----------|-----|
| A human in Discord/Slack | `spawn: topic` in chat |
| A session spawning a child | `spawn_session` tool (bridge) |
| External automation / pipeline | `hydra spawn` CLI |
| A script that might retry | `hydra spawn` CLI (idempotency) |
| A cron nudging an existing session | `hydra deliver` CLI |
| A session whispering to another session | `hydra deliver` CLI (via Bash) |
| A session posting visibly to another thread | `send_to_thread` tool (bridge) |

Two CLI primitives: **spawn** creates sessions, **deliver** messages existing ones. `deliver` is the whisper channel — messages go to the session's context only, never to the chat thread. `send_to_thread` is the visible channel — messages appear in the thread AND reach the session.

## Spawning a Session

```bash
hydra spawn "<prompt>" \
  --initiator "<who>" \
  --idempotency-key "<key>" \
  [--model <alias>] [--quiet] [--ephemeral]
```

**Both `--initiator` and `--idempotency-key` are required.** No defaults.

### The Three Decisions

**1. What's the idempotency key?**

The key prevents duplicate spawns. Pick a pattern based on intent:

```bash
# Task-scoped — same task won't spawn twice
--idempotency-key "pr-review-${PR_NUMBER}"

# Time-scoped — one per day/hour
--idempotency-key "daily-report-$(date +%Y-%m-%d)"

# One-shot — always unique
--idempotency-key "$(uuidgen)"
```

Key lifecycle: `pending` → `spawned` → `completed` (on session death). A key in `pending`, `spawned`, or `completed` state **blocks** new spawns (exit code 2). `failed` and `timed_out` keys allow retry. Keys expire after 24 hours.

**2. Who's the initiator?**

Identity of who triggered the spawn. Appears in announcements, stored for audit.

```bash
--initiator "dan.cetlin"       # human
--initiator "review-bot"       # automation
--initiator "session:cedar"    # another session
```

**3. What model?**

```bash
--model <alias>     # e.g. sonnet, haiku, opus, fable
```

Run `hydra spawn --help` for current aliases, or check `shared/constants.ts`. Omit for the daemon's default (`HYDRA_MODEL` env). Full model IDs also accepted.

### Optional Flags

| Flag | What |
|------|------|
| `--channel <id>` | Target channel (defaults to `DEFAULT_SESSION_CHANNEL`) |
| `--message <id>` | Anchor thread to this message (requires `--channel`) |
| `--quiet` | Suppress spawn announcement in chat |
| `--ephemeral` | Auto-kill on `[done]`, skip death visuals |

### Reading the Response

```json
{
  "sessionId": "uuid",
  "name": "spark",
  "threadId": "thread-id",
  "url": "https://discord.com/channels/...",
  "idempotencyKey": "your-key"
}
```

Exit codes: `0` success, `1` error, `2` idempotency hit (not an error — means "already handled").

## Common Patterns

**Spawn a worker:**
```bash
hydra spawn "analyze PR #42 for security issues" \
  --initiator "session:cedar" \
  --idempotency-key "pr-42-security-$(date +%s)" \
  --model sonnet --quiet
```

**Quick throwaway task:**
```bash
hydra spawn "fix the typo in README.md and commit" \
  --initiator "dan.cetlin" \
  --idempotency-key "$(uuidgen)" \
  --model haiku --ephemeral
```

**Scheduled automation:**
```bash
hydra spawn "generate daily standup report" \
  --initiator "scheduler" \
  --idempotency-key "standup-$(date +%Y-%m-%d)" \
  --quiet
```

## Delivering to a Session

The whisper channel — deliver a message to a session's context without posting to the chat thread.

```bash
hydra deliver --session <name> --message "<text>" \
  [--initiator "<who>"] [--idempotency-key "<key>"] [--queue]
```

`--session` (by name) is the primary addressing mode. `--thread <id>` is the alternative for callers that saved a thread ID at spawn time. Both can be given — they cross-validate.

`--initiator` defaults to `$USER`. `--idempotency-key` is optional (15min TTL, prevents duplicate delivery on retries).

### Default vs --queue

By default, `deliver` fails if the session's bridge is disconnected — callers get a binary signal. `--queue` opts into fire-and-forget: the message is persisted to `message-queue.json` and flushed when the bridge reconnects.

```bash
# Default: fail if unreachable
hydra deliver --session bloom --message "check replies"
# exit 4 if orphaned

# Opt-in: queue for later
hydra deliver --session bloom --message "check replies" --queue
# exit 0, status: queued
```

### Reading the Response

```json
{
  "status": "delivered",
  "proof": "socket_write",
  "sessionId": "uuid",
  "sessionName": "bloom",
  "threadId": "thread-id"
}
```

Exit codes: `0` delivered/queued, `1` bad request, `2` idempotency hit, `3` session gone, `4` orphaned, `5` still booting, `6` bridge write failed (transient).

### Common Patterns

**Cron nudge with respawn fallback:**
```bash
THREAD="1548796828059963513"
if ! hydra deliver --thread "$THREAD" --message "NUDGE: check replies" \
    --initiator "cron:bookkeeper" --idempotency-key "bk-nudge-w37" 2>/dev/null; then
  if [ $? -eq 3 ]; then
    hydra spawn "Resume bookkeeper: check replies" \
      --initiator "cron:bookkeeper" \
      --idempotency-key "bk-respawn-w37" \
      --channel "$THREAD" --read-thread 50
  fi
fi
```

**Cross-session communication:**
```bash
# From inside a session (via Bash tool):
hydra deliver --session bloom --message "PR #42 merged, you can close the review"
```

**Fire-and-forget nudge:**
```bash
hydra deliver --session bloom --message "check your PR watches" --queue
```

## Managing Sessions

| Command | What |
|---------|------|
| `hydra list` | Active sessions (name, status, context %) |
| `hydra status <name>` | Session detail |
| `hydra peek [name]` | Read-only view of session terminal |
| `hydra kill <name>` | Kill session (sets idempotency to `failed` — allows retry) |
| `hydra health` | Daemon diagnostics |

## Managing Idempotency

| Command | What |
|---------|------|
| `hydra check-key <key>` | Query key status (`not_found`, `pending`, `spawned`, `completed`, `failed`, `timed_out`) |
| `hydra clear-key <key>` | Remove a stuck key (unblocks retry) |

## Lifecycle Commands

| Command | What |
|---------|------|
| `hydra up <platform>` | Start daemon + byte |
| `hydra down <platform>` | Stop everything + unload watchdog |
| `hydra restart <platform>` | Compile check → restart daemon |
| `hydra install <platform>` | Install watchdog + preflight |

Global options: `--daemon <name>` (target specific daemon), `--json` (raw JSON output).

## Gotchas

1. **`--message` requires `--channel`** — can't anchor without a channel
2. **Exit code 2 is not an error** — it means "already handled," callers should treat as success
3. **Idempotency keys are case-sensitive** — `My-Key` ≠ `my-key`
4. **24h TTL** — keys auto-expire; for long-running automation, use fresh keys per run
5. **`hydra kill` sets idempotency to `failed`** — intentionally unblocks retry with same key
6. **CLI request timeout** — hardcoded in `sendRequest` (`cli/helpers.ts`), separate from the daemon's `HYDRA_SOCKET_TIMEOUT`. If the daemon is overloaded, the CLI may timeout before spawn completes

## Source

| File | What |
|------|------|
| `cli/hydra.ts` | Entry point, command dispatch |
| `cli/helpers.ts` | Socket communication, config resolution, `sendRequest` (10s timeout) |
| `cli/lifecycle.ts` | `up`/`down`/`restart`/`kill` orchestration |
| `cli/peek.ts` | Peek UI (tmux link-window) |
| `daemon/cli-handler.ts` | Daemon-side request dispatch |
| `daemon/idempotency.ts` | Idempotency state machine |
| `daemon/session-lifecycle.ts` | `doSpawnSession` primitive |
| `daemon/session-reachability.ts` | Reachability classification (used by deliver) |
| `shared/constants.ts` | Model aliases |
| `diagrams/flow-deliver.mmd` | Deliver flow diagram |

See also: `README.md` (quick start), `CLAUDE.md` (build/test), `docs/ONBOARDING_TIPS.md` (first-time setup).
