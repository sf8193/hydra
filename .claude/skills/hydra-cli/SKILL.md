---
name: hydra-cli
description: Use when spawning sessions via the hydra CLI, orchestrating multi-session work, or using hydra programmatically. Triggers on "hydra spawn", "use hydra to", "spin up a session", "spawn via CLI", or any request to programmatically create/manage hydra sessions.
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

The CLI's advantage over the bridge tool: **idempotency keys** prevent duplicate spawns across retries. If your automation might run twice, use the CLI.

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

Key lifecycle: `pending` → `spawned` → `completed` (on session death). A key in `pending` or `spawned` state **blocks** new spawns (exit code 2). A `failed` key allows retry. Keys expire after 24 hours.

**2. Who's the initiator?**

Identity of who triggered the spawn. Appears in announcements, stored for audit.

```bash
--initiator "dan.cetlin"       # human
--initiator "review-bot"       # automation
--initiator "session:cedar"    # another session
```

**3. What model?**

```bash
--model sonnet    # claude-sonnet-4-6[1m]
--model haiku     # claude-haiku-4-5-20251001
--model opus      # claude-opus-4-6[1m]
--model fable     # claude-fable-5[1m]
```

Omit for the daemon's default (`HYDRA_MODEL` env). Full model IDs also accepted. Aliases defined in `shared/constants.ts`.

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
| `hydra check-key <key>` | Query key status (`not_found`, `pending`, `spawned`, `completed`, `failed`) |
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
6. **Socket timeout is 10s** — if daemon is overloaded, CLI may timeout before spawn completes

## Source

| File | What |
|------|------|
| `cli/hydra.ts` | Entry point, command dispatch |
| `cli/helpers.ts` | Socket communication, config resolution |
| `daemon/cli-handler.ts` | Daemon-side request dispatch |
| `daemon/idempotency.ts` | Idempotency state machine |
| `daemon/session-lifecycle.ts` | `doSpawnSession` primitive |
| `shared/constants.ts` | Model aliases |

See also: `README.md` (quick start), `CLAUDE.md` (build/test), `docs/ONBOARDING_TIPS.md` (first-time setup).
