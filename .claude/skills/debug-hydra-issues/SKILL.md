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

Architecture details: `README.md`. Import topology: `docs/topology.mmd` / `docs/topology.html`. Flow diagrams: `diagrams/` (mmd source + png rendered).

## Resolve First

Before running any diagnostic, resolve these — half the confusing symptoms trace to the wrong value:

```bash
HYDRA_REPO="${HYDRA_REPO:-$(git rev-parse --show-toplevel 2>/dev/null)}"
[ -f "$HYDRA_REPO/daemon.ts" ] || { echo "error: resolve HYDRA_REPO to the hydra checkout" >&2; return 1 2>/dev/null || true; }
CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
PLATFORM="${CHAT_PLATFORM:-discord}"  # or slack
STATE_DIR="${HYDRA_STATE_DIR:-$CLAUDE_CONFIG_DIR/channels/$PLATFORM}"
[ -f "/Library/Application Support/ClaudeCode/managed-settings.json" ] && grep -q '"channelsEnabled": true' "/Library/Application Support/ClaudeCode/managed-settings.json" || echo "warning: managed-settings.json missing or channelsEnabled not set" >&2
```

Hydra resolves `CLAUDE_CONFIG_DIR` the same way (`cli/helpers.ts:70`). If the session runs under a non-default config dir, every `~/.claude` path in this doc is wrong unless you resolved this first.

**CLI fallback:** if `hydra` is not on PATH (no `hydra install` yet), use `bun "$HYDRA_REPO/cli/hydra.ts" <cmd> <platform>`.

## Step 0 — Is the Session Alive? (CC only)

Before any daemon check. Every daemon instrument can read green while the backing model is dead.

**Codex sessions** — pane-probe skips Codex entirely (`pane-probe.ts:524`). Instead: (1) check socket exists: `[ -S ~/.codex/hydra-<name>/app-server-control/app-server-control.sock ]`, (2) check process alive: `ps aux | grep codex`, (3) check for watchdog timeout in daemon log — `CodexEngine` fires after `WATCHDOG_MS` if a turn stalls (`codex-engine.ts`). If all three are clean but the session is silent, the issue is upstream (daemon/bridge).

```bash
tmux capture-pane -t <session-name> -p -J | tail -30
```

**What to look for:**

| Pane shows | Meaning |
|-----------|---------|
| `401`, `API Error` | Auth failure — see Step 1 |
| `Please run /login`, `Login expired`, `Select login method:` | Token expiry — see Step 1 |
| Plan mode dialog (three options) | Stuck on plan approval — send a response or dismiss |
| Resume prompt (`Resume from summary` / `Resume full session`) | CC is waiting for a resume choice |
| Complete silence (no output for minutes) | Bridge may be disconnected, or process exited |

**Signature worth memorizing:** *daemon green, gateway "connected", session silent on real messages.* The session looks healthy from outside but the model isn't processing. This is the most common failure and the most expensive to find by layer-walking.

The `pane-probe` module (`daemon/pane-probe.ts`) detects these states automatically on a 60s interval — `login_required` (stages: `expiring`, `blocked`, `oauth_url`, `success`), `plan_mode`, `resume_prompt`. If pane-probe hasn't alerted, the session may still be in its boot grace window.

## Step 1 — Auth (CC only)

Token expiry is routine. Treat it as a first-class hypothesis, not an edge case. **Codex sessions** authenticate differently — this section does not apply.

- **Keychain is scoped by config dir.** Claude Code stores credentials under roughly `Claude Code-credentials-SHA256($CLAUDE_CONFIG_DIR)[:8]`. A valid token in the default keychain entry does nothing for a session running under a different config dir. Symptom: you re-authenticate, it "takes", but the session stays broken — because the session reads a different entry.

- **`CLAUDE_CODE_OAUTH_TOKEN` skips the keychain.** Setting this env var makes Claude Code bypass keychain entirely. Side effect: every OAuth-based MCP server silently stops working. Presenting symptom: "MCPs are broken." Cause: auth configuration, not MCP.

- **`restart` only cycles the daemon — the byte keeps running.** `lifecycleRestart` restarts the daemon process but does not touch the byte session, transcription, or watchdog. The byte keeps running with whatever auth, env, and config it had at boot. **Decision rule:** if the issue is in the daemon (config reload, code change, module graph), `restart` is correct and less disruptive. If the issue is auth, env, or anything the byte baked in at launch, `restart` leaves the stale byte running — use `hydra down <platform>` then `hydra up <platform>`.

## Step 2 — Daemon & Bridge

**Codex note:** Codex sessions use unix sockets, not MCP bridges. The bridge process count and bridge MCP logs below are CC-only. For Codex, check socket connectivity and `CodexEngine` events in the daemon log.

```bash
hydra health                       # daemon diagnostics — sessions, bridges, connections
tmux ls                            # are tmux sessions running?
tail -100 ~/hydra-${PLATFORM}-daemon.log | grep -i "error\|warn\|crash\|fail"
```

**Do not read `~/hydra-daemon.log`** — it interleaves both platforms. Always use the per-platform log.

**Investigation method when health gives no lead:**

1. **Compare counts.** Bridge processes (`ps aux | grep "bun server.ts" | grep -v grep | wc -l`) should roughly equal session count in `$STATE_DIR/sessions.json`. Mismatch = orphans or leaks.

2. **Check sessions.json fields.** `claudeSessionId: null` → bridge never connected. `listening: false` → session is muted. These explain "not responding" without a crash.

3. **Trace the message path.** Gateway (`{platform}-gateway.ts`) → `router.ts` → `bridge-transport.ts` → bridge → CC/Codex. Find where it stops. If the daemon log shows delivery but the session doesn't respond, check bridge MCP logs (keyed by Claude session UUID): macOS `~/Library/Caches/claude-cli-nodejs/{project-slug}/mcp-logs-plugin-discord-discord/*.jsonl`, Linux `${XDG_CACHE_HOME:-~/.cache}/claude-cli-nodejs/...`.

## Step 3 — Spawn & Resume Failures

Recovery flows through three tiers (see `diagrams/flow-recovery-cascade.mmd`):

| Tier | Method | Context preserved |
|------|--------|-------------------|
| T1 | `--resume` | Full conversation |
| T2 | `--resume --fork-session` | Transcript copy |
| T3 | `tryRespawn` — fresh session | Thread history only |

**The hidden failure shape:** T1 and T2 both look up the stored `claudeSessionId` in the config dir the session launches under. If the conversation file isn't there, **both tiers fail identically and for the same reason** — but it reads like three independent failures instead of one cause.

- **Signature:** session exits seconds after start. Pane log says `No conversation found with session ID: <uuid>`. This is not a crash — it's a lookup miss. Nothing is corrupt. No amount of restarting fixes it.
- **Fix:** `respawn`. Don't retry `resume`.
- **Root cause:** compare config dirs. The session may be launching under a different `$CLAUDE_CONFIG_DIR` than where the conversation was stored.

**Don't trust the correlate line.** The observability layer (`daemon/observability.ts`) resolves transcript paths against a base path that may differ from the session's actual config dir. The daemon log can print a transcript path *that exists* while the session itself cannot see it. Verify which config dir the file is actually under.

The kill/orphan classification lives in `daemon/resume-health.ts`. Trap: **when no exit-marker path was configured, a fully alive session is still classified `kill`** — "absence of evidence is not evidence of liveness." Symptom: the cascade killed a running session for no visible reason. The periodic orphan detector (`daemon/session-health.ts`) checks the same condition — both must agree on preserve-vs-kill, or the incoherence is itself a bug.

For daemon issues, `hydra restart <platform>` validates the module graph first — safe to run.

## Step 4 — Environment

**tmux server filesystem access.** If spawns fail but existing sessions work, the tmux server may have lost filesystem access (this caused a real 45-minute outage):

```bash
tmux new-session -d -s _probe "ls $HYDRA_REPO > /tmp/probe.txt 2>&1; sleep 5"
cat /tmp/probe.txt
```

"Operation not permitted" → the tmux server itself is broken. Fix: `tmux kill-server` + `hydra up <platform>` from a terminal with filesystem access granted. Capture the session inventory first (`hydra list > /tmp/inventory.txt`) — sessions die but threads persist, so selectively respawn.

**`timeout` is not on stock macOS.** Diagnostic one-liners using `timeout` error confusingly — the command fails, not the thing being measured. Use `gtimeout` (from coreutils) or a shell equivalent.

**`git pull --ff-only` breaks with local commits.** Check ahead/behind first (`git rev-list --left-right --count HEAD...@{u}`), rebase if needed.

**Check upstream before debugging a test.** Before sinking time into a failing test, check if it already fails on main: `git stash && git checkout origin/main && bun test <file> && git checkout - && git stash pop`. Saves you from "fixing" a known-broken test.

## Traps That Waste Time

- **`bun`'s "low max file descriptors" error is a lie.** It scans cwd for `package.json`, gets EPERM, and misattributes. `ulimit -n` changes nothing. The real cause is filesystem access — check the tmux server (step 4 above).

- **`ps` argv is inherited by children.** `caffeinate` processes show claude's argv but are not claude. Check the process tree (`pstree` or `ps -o pid,ppid,comm`), not just the name.

- **Orphan detection has a 90s grace window.** The daemon polls for tmux-alive + bridge-disconnected sessions and alerts the thread after `ORPHAN_GRACE_MS` (90s). It also auto-discovers `claudeSessionId` from `~/.claude/sessions/<pid>.json` — note: this path is **hardcoded to homedir** in `session-lifecycle.ts`, not `$CLAUDE_CONFIG_DIR`. A session under a suffixed config dir has its sessionId discovered from the wrong location. If no alert has fired but the session seems mute, it may still be in its boot grace window. The `pane-probe` module (`probeAllSessions()`, 60s interval) also detects sessions stuck on login or plan mode.

- **`bun run` is lazy.** Parse/export errors surface only when a module is imported, not at launch. A broken merge boots "fine" until the crashing code path loads.

- **Main bridge flapping** (`main bridge reconnected (cycle N, last uptime 0s)` repeating in logs) means two processes are both claiming to be `main`. They evict each other in a loop. Find duplicates: `ps aux | grep caffeinate | grep claude`.

- **Don't trust `~/hydra-daemon.log`.** Both platforms tee into it. Read the per-platform logs instead.

## Where Things Live

| What | Path |
|------|------|
| Repo | `$HYDRA_REPO` (GitHub: `sf8193/hydra`) |
| Per-platform state | `$STATE_DIR` (`$CLAUDE_CONFIG_DIR/channels/{discord,slack}/`) |
| Session registry | `$STATE_DIR/sessions.json` |
| Daemon PID / heartbeat / socket | `$STATE_DIR/daemon.{pid,alive,sock}` |
| Per-platform daemon log | `~/hydra-${PLATFORM}-daemon.log` |
| Per-session spawn logs | `$STATE_DIR/spawn-logs/{name}-{uuid}.log` |
| Bridge MCP logs | macOS: `~/Library/Caches/claude-cli-nodejs/{project-slug}/mcp-logs-plugin-discord-discord/*.jsonl`; Linux: `${XDG_CACHE_HOME:-~/.cache}/claude-cli-nodejs/...` |
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

## Recovery

**Dangerous operations** (`tmux kill-server`, recursive `pkill`, `hydra down`) — confirm with the human before executing.
