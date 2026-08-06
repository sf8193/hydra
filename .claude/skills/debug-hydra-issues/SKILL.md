---
name: debug-hydra-issues
description: Use when hydra is broken — sessions not responding, spawns failing, daemon won't start, bridges disconnecting. Orients you to the diagnostic tools, file locations, and traps learned from real outages.
---

# Debugging Hydra Issues

Hydra is a four-layer pipeline. Sessions run Claude Code or Codex as their backend (`engine: 'claude' | 'codex'` on SessionInfo) — everything here applies to both unless noted.

```
Discord/Slack Gateway → Daemon → Bridge (MCP) → Claude Code / Codex
```

Each layer can fail independently. The daemon is long-lived (one per platform). Each Claude session gets its own bridge. The byte is the main session; spawns are children in threads.

Architecture details: `README.md`. Import topology: `docs/topology.mmd` / `docs/topology.html`.

Key flow diagrams in `diagrams/` (mmd source + png rendered):
- `flow-spawn` / `flow-cli-spawn` — how sessions are created through each layer
- `flow-recovery-cascade` — resume → fork-transcript → respawn tiers + death detection
- `flow-protocol-robustness` — protocol phases, mutual exclusion, disconnect grace handling
- `command-topology` — two-channel routing (chat + CLI) to shared daemon primitives
- `health-topology` — runtime component connections and state file locations

## First: Health Check

Run these before investigating anything:

```bash
# Is the daemon alive?
hydra health

# Are tmux sessions running?
tmux ls

# Recent errors — read the per-platform log, not ~/hydra-daemon.log (it interleaves both)
tail -100 ~/hydra-discord-daemon.log | grep -i "error\|warn\|crash\|fail"

# Session state
cat ~/.claude/channels/discord/sessions.json | python3 -m json.tool | head -50

# Is the byte's bridge connected?
grep "bridge registered for session main" ~/hydra-discord-daemon.log | tail -3
```

## Where Things Live

| What | Path |
|------|------|
| Repo | `~/Documents/angellist/hydra` (GitHub: `sf8193/hydra`) |
| Per-platform state | `~/.claude/channels/{discord,slack}/` |
| Session registry | `{state_dir}/sessions.json` |
| Daemon PID / heartbeat / socket | `{state_dir}/daemon.{pid,alive,sock}` |
| Per-platform daemon log | `~/hydra-{platform}-daemon.log` |
| Per-session spawn logs | `{state_dir}/spawn-logs/{name}-{uuid}.log` |
| **Bridge MCP logs** | `~/Library/Caches/claude-cli-nodejs/{project-slug}/mcp-logs-plugin-discord-discord/*.jsonl` — keyed by Claude session UUID. This is where bridge misbehavior actually lives. Undiscoverable without knowing CC internals. |
| Managed settings gate | `/Library/Application Support/ClaudeCode/managed-settings.json` — must contain `{"channelsEnabled": true}` |

## Diagnostic Tools

| Tool | What |
|------|------|
| `hydra health` | Daemon diagnostics — sessions, bridges, connections |
| `hydra list` | Active sessions with status and context % |
| `hydra peek <name>` | Read a session's terminal output (non-intrusive) |
| `tmux capture-pane -t <name> -p` | Direct pane capture |
| `ps aux \| grep -E "claude\|codex\|bun server.ts"` | Find orphaned processes |

From chat: `health`, `list sessions`, `peek <name>`.

## How to Investigate

When the health check gives you a lead, follow it. When it doesn't, use this method:

1. **Compare counts.** Bridge processes (`ps aux | grep "bun server.ts" | grep -v grep | wc -l`) should roughly equal session count in `sessions.json`. A mismatch means orphans or leaked processes.

2. **Read the per-platform daemon log.** Not `~/hydra-daemon.log` — that interleaves both platforms. Scan for the last error, the last restart, and the last bridge registration.

3. **Check sessions.json fields.** `claudeSessionId: null` means the bridge never connected. `listening: false` means the session is muted. These explain "not responding" without a crash.

4. **Trace the message path.** A message flows: gateway → `router.ts` (command intercept + routing) → `bridge-transport.ts` (delivery) → bridge → Claude Code. Find where it stops. If the daemon log shows delivery but the session doesn't respond, the bridge is the suspect — check the bridge MCP logs.

5. **Check the tmux server.** If spawns fail but existing sessions work, the tmux server may have lost filesystem access (this caused a real 45-minute outage). Test: `tmux new-session -d -s _probe 'ls ~/Documents/angellist/hydra > /tmp/probe.txt 2>&1; sleep 5'` then `cat /tmp/probe.txt`. "Operation not permitted" means the tmux server itself is broken — a `tmux kill-server` + `hydra up` from a granted terminal is the fix.

## Traps That Waste Time

- **`bun`'s "low max file descriptors" error is a lie.** It scans cwd for `package.json`, gets EPERM, and misattributes. `ulimit -n` changes nothing. The real cause is filesystem access — check the tmux server (step 5 above).

- **`ps` argv is inherited by children.** `caffeinate` processes show claude's argv but are not claude. Check the process tree (`pstree` or `ps -o pid,ppid,comm`), not just the name.

- **Orphan detection has a 90s grace window.** The daemon polls for tmux-alive + bridge-disconnected sessions and alerts the thread after `ORPHAN_GRACE_MS` (90s). It also auto-discovers `claudeSessionId` from `~/.claude/sessions/<pid>.json`. If no alert has fired but the session seems mute, it may still be in its boot grace window. The `pane-probe` module (`probeAllSessions()`, 60s interval) also detects sessions stuck on login or plan mode.

- **`bun run` is lazy.** Parse/export errors surface only when a module is imported, not at launch. A broken merge boots "fine" until the crashing code path loads.

- **Main bridge flapping** (`main bridge reconnected (cycle N, last uptime 0s)` repeating in logs) means two processes are both claiming to be `main`. They evict each other in a loop. Find duplicates: `ps aux | grep caffeinate | grep claude`.

- **Don't trust `~/hydra-daemon.log`.** Both platforms tee into it. Read the per-platform logs instead.

## Recovery

For session-level issues, use `resume` (reconnects with full context) or `respawn` (fresh session, reads thread history). For daemon issues, `hydra restart <platform>` validates the module graph first — safe to run.

For tmux server failure (step 5 above), capture the session inventory (`hydra list > /tmp/inventory.txt`) before `tmux kill-server`. Sessions die but threads persist — selectively respawn from the inventory.

**Dangerous operations** (`tmux kill-server`, recursive `pkill`, `hydra down`) — confirm with the human before executing.
