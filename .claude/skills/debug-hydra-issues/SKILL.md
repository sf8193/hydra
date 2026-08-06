---
name: debug-hydra-issues
description: Use when debugging hydra daemon issues — sessions not responding, spawns failing, bridges disconnecting, fleet health problems. Orients a fresh session with the diagnostic tools, file locations, and incident patterns learned from real outages.
---

# Debugging Hydra Issues

This skill orients you to debug hydra daemon problems. Everything here was learned from real incidents — not hypothetical failure modes.

## First: Five-Second Health Check

Run these before anything else:

```bash
# 1. Is the daemon alive?
hydra health

# 2. Are tmux sessions running?
tmux ls

# 3. Recent daemon errors (per-platform — don't use ~/hydra-daemon.log, it interleaves both platforms)
tail -100 ~/hydra-discord-daemon.log | grep -i "error\|warn\|crash\|fail"
tail -100 ~/hydra-slack-daemon.log | grep -i "error\|warn\|crash\|fail"

# 4. Session state
cat ~/.claude/channels/discord/sessions.json | python3 -m json.tool | head -50

# 5. Is the byte's main bridge connected?
grep "bridge registered for session main" ~/hydra-discord-daemon.log | tail -3
```

## Where Things Live

| What | Path |
|------|------|
| Repo | `~/Documents/angellist/hydra` |
| Discord state | `~/.claude/channels/discord/` |
| Slack state | `~/.claude/channels/slack/` |
| Session registry | `{state_dir}/sessions.json` |
| Thread registry | `{state_dir}/threads.json` |
| Access config | `{state_dir}/access.json` |
| Daemon heartbeat | `{state_dir}/daemon.alive` |
| Daemon PID | `{state_dir}/daemon.pid` |
| Unix socket | `{state_dir}/daemon.sock` |
| Per-platform daemon log | `~/hydra-{platform}-daemon.log` |
| Per-platform byte log | `~/hydra-{platform}-byte.log` |
| Per-session spawn logs | `{state_dir}/spawn-logs/{name}-{uuid}.log` |
| Factory history | `~/.hydra/factory/history.jsonl` |
| Protocol transcripts | `{state_dir}/transcripts/` |
| **Bridge MCP logs (the gold)** | `~/Library/Caches/claude-cli-nodejs/{project-slug}/mcp-logs-plugin-discord-discord/*.jsonl` — keyed by Claude session UUID. This is where "why did the bridge misbehave" actually lives. Undiscoverable without knowing Claude Code internals. |
| Managed settings gate | `/Library/Application Support/ClaudeCode/managed-settings.json` — must contain `{"channelsEnabled": true}` |

## Diagnostic Tools

### CLI (from any terminal)
| Command | What it shows |
|---------|--------------|
| `hydra health` | Daemon diagnostics — connected sessions, bridge status |
| `hydra list` | Active sessions with status, context %, model |
| `hydra status <name>` | Detailed session info |
| `hydra peek <name>` | Read last N lines of session's tmux output (non-intrusive) |

### Chat commands (from Discord/Slack)
| Command | What it shows |
|---------|--------------|
| `health` | Same as CLI health, rendered in chat |
| `list sessions` | Session table with lineage |
| `protocols` | Active review/build/design protocols |
| `peek <name>` | Peek a session's terminal from chat |

### Direct inspection
```bash
# Attach to a daemon's tmux (read-only observation)
tmux attach -t discord-daemon
tmux attach -t slack-daemon

# Peek a session's pane without attaching
tmux capture-pane -t <session-name> -p | tail -50

# Process tree — find orphaned claudes or bridges
ps aux | grep -E "claude|bun server.ts" | grep -v grep

# Check bridge count vs session count (should be roughly equal)
ps aux | grep "bun server.ts" | grep -v grep | wc -l
cat ~/.claude/channels/discord/sessions.json | python3 -c "import json,sys; print(len(json.load(sys.stdin)))"

# Check if a session's bridge is actually connected
grep "<session-name>" ~/hydra-discord-daemon.log | grep -E "register|disconnect" | tail -5
```

## Symptom → Diagnosis

### "Session is not responding to messages"

**Check in order:**
1. Is the session's tmux alive? `tmux has-session -t <name>`
2. Is its bridge registered? Check `sessions.json` for `claudeSessionId` — if `null`, bridge never connected
3. Is it listening? Check `listening` field in `sessions.json` — `false` means it's muted
4. Is a protocol running? `protocols` — protocol mutual exclusion blocks normal message delivery
5. Is context exhausted? `peek <name>` — look for "context limit" messages

**If tmux-alive but bridge-disconnected:** This is an orphan (canon gotcha #64). The session is doing work but can't reply. The `AND` condition in crash detection (`tmux-dead AND bridge-disconnected`) means orphans are invisible to self-heal. See Recovery section.

### "Spawn fails"

**Check in order:**
1. Compile gate? `bun build daemon.ts --target bun --outdir /tmp/hb` — if this fails, the daemon won't start new sessions
2. Thread already occupied? Error: `thread has a live session (X)` — kill or respawn, don't spawn fresh
3. TCC / filesystem access? **This caused a 25-minute outage on 2026-07-31.** Probe from inside the daemon's tmux server: `tmux new-session -d -s _tcc 'ls ~/Documents/angellist > /tmp/tcc.txt 2>&1; sleep 30'`. If "Operation not permitted," the tmux server lost filesystem access — see Recovery.
4. Factory spawn? Check `anchorChannelId` in `sessions.json` for the PM session. If missing, factory falls back to the PM's thread ID as `chatId` — fixed in PR #190 but may recur if `anchorChannelId` is absent

**The bun error "possibly due to low max file descriptors" is a lie.** bun scans cwd for `package.json` at startup, gets EPERM, and misattributes it. Raising `ulimit -n` changes nothing. `bun --version` succeeds because it never touches cwd. This wasted 4 rounds of investigation on 2026-07-31.

### "Daemon won't restart"

**Check in order:**
1. Module validation probe? `hydra restart` runs a probe subprocess that imports the daemon module graph. If it fails, the old daemon stays running (by design). Check stderr for the probe failure.
2. Is the checkout on the right branch? **The main checkout must stay on `live`, always** (canon gotcha #66). The watchdog restarts from whatever is checked out. If it's a feature branch, the running daemon executes code nobody intended to deploy.
3. tmux server health? If the tmux server itself lost filesystem access (gotcha #65), nothing new can launch under it — restart won't work, spawns won't work, but existing sessions keep running.

### "Factory build fails"

**Check in order:**
1. "thread has a live session" error? Factory tries to fork the PM into a builder in a new thread. If `anchorChannelId` is missing on the PM session AND `doSpawnSession` can't resolve the parent channel, it may try to spawn into the PM's thread.
2. Builder crashes immediately? Check spawn logs: `{state_dir}/spawn-logs/{builder-name}-*.log`
3. Review fails to start? Factory transitions to `awaiting_pm` and notifies — check the PM's thread
4. Factory state lost after restart? The `builds` map is in-memory only. `factory_retry`/`factory_accept`/`factory_abandon` won't work after daemon restart — use `peek_session` + `kill_session` directly

### "Main bridge is flapping"

Symptoms: rapid `main bridge reconnected (cycle N, last uptime 0s)` in daemon log.

**Root cause:** Two processes registered as `main`. The flap circuit breaker **explicitly exempts `main`** (canon gotcha #32), so they evict each other in an unbounded loop.

**How duplicates arise:** A byte restart that doesn't cleanly replace the prior byte — the new `caffeinate -i claude` spawns nested inside the old byte.

**Fix:** Kill all byte claudes (they outlive `tmux kill-session` — kill PIDs directly), relaunch exactly one. Check with `ps aux | grep caffeinate | grep claude`.

**Mitigated in #183:** Bridge identity via `HYDRA_ROLE=main` replaces the `?? 'main'` fallback. Unconfigured bridges get `stray-` prefix. Flap guard (#126) remains as defense-in-depth.

## Three Eras of Debugging History

### Era 1: Bridge Resilience (June 2026)
The daemon could crash-loop silently — watchdog faithfully restarted it every 120s while DMs got nothing. The compile gate caught import errors but not runtime crashes. Self-heal existed for Slack but not Discord. Lessons: heartbeat must be connectivity-aware (not just process-alive), compile check must run before killing the incumbent, and the watchdog must check both daemon AND byte.

### Era 2: The Orphan/Flap War (July 23, 2026)
A connectivity flap during spawn created an orphaned session (tmux-alive, bridge-never-registered). Manual recovery under-killed — left a bridge subprocess alive, causing duplicate registration, eviction ping-pong, and circuit breaker kills. 27 bridge processes vs 17 sessions. The QOL_BACKLOG (Q1-Q20) was born from this single incident. Key diagnostic discovery: bridge MCP logs at `~/Library/Caches/claude-cli-nodejs/...` are the gold — daemon logs alone can't explain bridge behavior.

### Era 3: The Fleet Outage (July 31, 2026)
The 45-day-old default tmux server lost filesystem access to `~/Documents`. Every new `bun` and `claude` launched under it died, but existing processes kept running — so the fleet looked healthy while nothing new could start. Three symptoms, one cause: daemon restart failed, spawns went to zombie, respawn fell through all tiers. `bun`'s error message ("low max file descriptors") was wrong and drove 4 wasted investigation rounds. Root cause still not definitively settled — endpoint security agent is leading candidate over TCC. Recovery: `tmux kill-server` → `hydra up` from a granted terminal. Principle 7 (health checks assert the outcome, not the precondition) was born here.

## Recovery Playbook

### Session recovery (least to most disruptive)
1. **`resume`** — reconnects with full context (`--resume`). Three-tier cascade: full context → fork transcript → respawn from thread. Best option when session has a valid `claudeSessionId`.
2. **`respawn`** — fresh session reads thread history via `fetch_messages`. Loses in-memory context but the thread carries the continuity (Design Principle 2).
3. **`recover`** — batch recovery from DM channel. Cascade: tryResume → tryRespawn. Max 2 concurrent, 5s stagger.

### Daemon recovery
```bash
# Restart daemon only (byte reconnects automatically)
hydra restart discord   # validates module graph first, keeps old daemon if probe fails
hydra restart discord --fast   # skip validation

# Full restart
hydra down discord && hydra up discord
```

### Nuclear recovery (tmux server rebuild)
When the tmux server itself is broken (gotcha #65 — lost filesystem access):
```bash
# 1. Capture inventory FIRST
hydra list > /tmp/session-inventory.txt

# 2. Kill server from a terminal that has filesystem access (not from inside the broken server)
tmux kill-server

# 3. Restart from a granted terminal
hydra up discord
hydra up slack

# 4. Reload watchdogs
# (launchd plists auto-loaded by hydra up)

# 5. Sessions are dead — threads persist. Selectively respawn from the inventory.
```

### Orphan recovery (tmux-alive, bridge-disconnected)
**Do NOT use `resume-orphan-session.sh` as written — it under-kills** (canon gotcha #64, QOL Q13).

The safe manual path:
1. Capture the session's Claude UUID from its tmux pane — look for `Resume: claude --resume <uuid>`
2. Kill the FULL descendant tree: `pkill -TERM -P <pane-pid>` recursively
3. Verify no lingering `bun server.ts` for the old hydra ID: `ps aux | grep "bun server.ts" | grep -v grep`
4. Relaunch in the shared tmux server replicating the daemon's resume form
5. Verify `sessions.json` `claudeSessionId` flips from `null` to the UUID

## Key Gotchas to Remember

- **Don't trust `~/hydra-daemon.log`** — both platforms `tee` into it. Read the per-platform logs instead.
- **`ps` argv is inherited by children** — `caffeinate` processes show claude's argv but are not claude. Check the process tree, not just the name.
- **Bridge MCP logs are the gold** for diagnosing bridge behavior, but they're in an undiscoverable location (see "Where Things Live").
- **The `AND` condition in crash detection means orphans are invisible** — `tmux-dead AND bridge-disconnected` both must be true.
- **`bun run` is lazy** — parse/export errors surface only when a module is imported, not at launch. A broken merge boots "fine" until the crashing module loads.
- **Diagnostic claims in the LOG have been wrong before** — the 2026-07-23 "nested duplicate byte claudes" was incorrect (they were bare `caffeinate` processes). Always verify process trees before acting on logged diagnoses.
