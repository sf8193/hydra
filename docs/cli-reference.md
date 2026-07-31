# Hydra CLI Reference

The machine channel into the hydra daemon. Same primitives as chat commands (`spawn:`, `kill`, etc.) but with idempotency, structured responses, and automation support.

See also: `README.md` (quick start), `CLAUDE.md` (build/test conventions).

## Spawn

```bash
hydra spawn "<prompt>" \
  --initiator "<who>" \
  --idempotency-key "<key>" \
  [--model <alias>] \
  [--channel <id>] [--message <id>] \
  [--quiet] [--ephemeral]
```

**Both `--initiator` and `--idempotency-key` are required.** No defaults, no shortcuts.

### Idempotency Keys

The CLI's only safety gate. Prevents duplicate spawns across retries.

| Key state | Spawn attempt | Result |
|-----------|--------------|--------|
| Not found | Allowed | Creates session, key → `pending` → `spawned` |
| `pending` or `spawned` | **Blocked** | Exit code 2 |
| `completed` | **Blocked** | Exit code 2 (session ran and died) |
| `failed` | Allowed | Retry permitted |
| Expired (24h TTL) | Allowed | Pruned automatically |

**Key patterns:**
```bash
# Automation — deterministic, prevents re-runs
--idempotency-key "daily-report-$(date +%Y-%m-%d)"

# One-shot — unique per invocation
--idempotency-key "$(uuidgen)"

# Task-scoped — idempotent per task
--idempotency-key "pr-review-${PR_NUMBER}"
```

**Stuck key?** `hydra check-key <key>` to inspect, `hydra clear-key <key>` to unblock.

### Initiator

Who triggered the spawn. Stored in session metadata, appears in announcements.

```bash
--initiator "username"            # human
--initiator "review-bot"          # automation
--initiator "session:cedar"       # another session
```

### Model Selection

```bash
--model sonnet                    # alias → claude-sonnet-4-6[1m]
--model haiku                     # alias → claude-haiku-4-5-20251001
--model opus                      # alias → claude-opus-4-6[1m]
--model fable                     # alias → claude-fable-5[1m]
--model claude-opus-5             # full ID
```

Aliases defined in `shared/constants.ts`. Unknown models rejected with suggestions.

### Flags

| Flag | What |
|------|------|
| `--channel <id>` | Target channel (defaults to `DEFAULT_SESSION_CHANNEL`) |
| `--message <id>` | Anchor thread to this message (requires `--channel`) |
| `--quiet` | Suppress spawn announcement |
| `--ephemeral` | Auto-kill on `[done]`, skip death visuals |

### Response

```json
{
  "sessionId": "uuid",
  "name": "spark",
  "threadId": "thread-id",
  "url": "https://discord.com/channels/...",
  "idempotencyKey": "your-key"
}
```

### Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Error (bad args, socket failure, spawn failure) |
| 2 | Idempotency hit (spawn blocked — not an error) |

## All Commands

### Lifecycle (platform required)

| Command | What |
|---------|------|
| `hydra up <platform>` | Start daemon + byte |
| `hydra down <platform>` | Stop everything + unload watchdog |
| `hydra restart <platform>` | Compile check → restart daemon |
| `hydra install <platform>` | Install watchdog + preflight |
| `hydra uninstall <platform>` | Remove watchdog |
| `hydra preflight <platform>` | Verify deployment is ready |
| `hydra watchdog <platform>` | Single health check tick (for launchd) |

### Session Management (require running daemon)

| Command | What |
|---------|------|
| `hydra spawn <prompt>` | Spawn a new session (see above) |
| `hydra list` | Active sessions (name, status, context %) |
| `hydra status <name>` | Session detail (name or sessionId) |
| `hydra peek [name]` | Read-only view of session terminal |
| `hydra kill <name>` | Kill session (idempotency → `failed`) |
| `hydra health` | Daemon diagnostics |
| `hydra check-key <key>` | Query idempotency status |
| `hydra clear-key <key>` | Remove stuck key |

Global options: `--daemon <name>` (target specific daemon), `--json` (raw JSON output).

## CLI vs Chat Spawn

Both use the same `doSpawnSession` primitive. Key differences:

| | Chat (`spawn: topic`) | CLI (`hydra spawn`) |
|-|----------------------|-------------------|
| **Safety gate** | `access.allowFrom` list | Idempotency key |
| **Model syntax** | `spawn sonnet: topic` | `--model sonnet` |
| **Announcement** | Auto emoji + message | Plain (suppressible with `--quiet`) |
| **Return value** | Posts to thread | JSON with sessionId, URL, key |
| **Headless** | No | `--ephemeral` |
| **Retry safety** | N/A | Idempotency blocks duplicates |

## Common Patterns

**Spawn a worker from a running session:**
```bash
hydra spawn "analyze PR #42 for security issues" \
  --initiator "session:cedar" \
  --idempotency-key "pr-42-security-$(date +%s)" \
  --model sonnet --quiet
```

**Spawn with a specific model for a quick task:**
```bash
hydra spawn "fix the typo in README.md and commit" \
  --initiator "username" \
  --idempotency-key "$(uuidgen)" \
  --model haiku --ephemeral
```

**Check if a spawn already ran:**
```bash
hydra check-key "daily-report-2026-07-31"
# Returns: { key, status: "spawned", sessionId: "..." }
```

## spawn_session Tool (Bridge Alternative)

Sessions with main-session privileges can spawn via the `spawn_session` MCP tool:

```
spawn_session(topic: "build feature X", model: "sonnet", worktree: "options_bot")
```

This goes through the bridge, not the CLI socket. Same `doSpawnSession` primitive underneath. Use this from within a session; use the CLI from external automation.

## Gotchas

1. **`--message` requires `--channel`** — can't anchor without a channel
2. **Exit code 2 is not an error** — it means "already handled," callers should treat as success
3. **Idempotency keys are case-sensitive** — `My-Key` ≠ `my-key`
4. **24h TTL** — keys auto-expire; for long-running automation, use fresh keys per run
5. **`hydra kill` sets idempotency to `failed`** — unblocks retry with the same key
6. **Socket timeout is 10s** — if daemon is overloaded, CLI may timeout before spawn completes

## Source

| File | What |
|------|------|
| `cli/hydra.ts` | Entry point, command dispatch |
| `cli/helpers.ts` | Socket communication, config resolution |
| `cli/lifecycle.ts` | `up`/`down`/`restart` orchestration |
| `cli/peek.ts` | Peek UI |
| `daemon/cli-handler.ts` | Daemon-side request dispatch |
| `daemon/idempotency.ts` | Idempotency state machine (TTL, pruning) |
| `daemon/session-lifecycle.ts` | `doSpawnSession` primitive |
| `shared/constants.ts` | Model aliases, known models |
