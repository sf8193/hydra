# Reference

The commands are in `hydra --help` and every `hydra.toml` key is commented in [`hydra.example.toml`](../hydra.example.toml). This page is what those two do not say.

## CLI

All operations go through the `hydra` CLI (`bun cli/hydra.ts`, or an alias to `hydra`).

```bash
hydra install|uninstall|preflight <platform>   # launchd watchdog; preflight verifies the deployment
hydra up|down|restart <platform>               # daemon + byte; restart restarts the daemon only
hydra spawn|list|status|kill|peek|health ...  # sessions and diagnostics; `kill --destroy` also deletes its thread
```

The watchdog runs every 120 s. It restarts the daemon when its tmux session is gone, its heartbeat is over 300 s stale, or it spins at 90% of a core for two ticks. The third restart within an hour DMs you. The daemon's vitals tick (every minute) also alerts on host overload and memory pressure; thresholds are `[vitals]` in `hydra.toml`, and the daemon log's vitals header shows the readings.

## Configuration

Four homes, each for one kind of fact:

| Where | Holds | Who writes it |
|---|---|---|
| `<state dir>/.env` | how the daemon runs: `SPAWN_CWD`, `HYDRA_MODEL`, bot tokens. Hydra removes every token it holds from the environment of the sessions it starts, but the file stays readable by any session not confined away from it, and a name only the daemon's own shell exports is not covered | you |
| `<state dir>/hydra.toml` | whom it serves: operator, people, connectors, specialists, schedules, rules. Re-read within a second of a change | you |
| `<state dir>/` state files (`sessions.json`, `threads.json`, …) | what it remembers | hydra only |
| a specialist's `workdir` | what the agent knows: its `CLAUDE.md`, skills and files | you and the agent |

The state dir is `~/.claude/channels/<platform>/` by default. To start from an old install (`access.json`, `specialists.json`, `slack-watch.json`), stop the daemon and run `hydra migrate <platform>` (`--dry-run` first). It keeps every file it changes as `*.migrated`. A daemon refuses to start while `hydra.toml` sits beside old state it replaces, and says why.

- **Bot tokens** are set in `.env`: `DISCORD_BOT_TOKEN`, or `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`.
- **Access control:** [ACCESS.md](../ACCESS.md). The `operator` is the one person who runs commands.
- **Main's model:** `[main] model` is the model main starts with (a Claude alias or full ID). It applies at main's next start (`hydra down`, then `up`).
- **Destroying an ended session's thread:** `[threads] allow_destroy = true` lets `hydra kill <name or thread id> --destroy` delete the thread of a session that has ended. It never deletes a channel, a DM, a specialist's home thread or a thread a live session is in.
- **Adding from another repo:** `hydra config add <fragment.toml>` appends the `[specialists.*]` and `[schedules.*]` tables of a fragment (`--dry-run` prints them). A table already there is left alone, a differing one is refused, and nothing is written unless the result loads.
- **Two platforms at once:** `hydra install` and `hydra up` each platform; each gets its own daemon, state dir and watchdog.
- **Specialists:** [specialists.md](specialists.md).

### Voice dictation

The daemon transcribes inbound audio attachments (Discord voice notes, Slack clips) with a self-hosted sidecar (`transcribe-server/`), so audio never leaves your machine, and merges the text into the message as `[voice transcript] …`. Try it with no model: `./start-transcribe.sh mock`. For real transcription run `./transcribe-server/setup.sh` once (needs ffmpeg); the sidecar then starts with the daemon. Without a reachable sidecar, audio passes through. `HYDRA_TRANSCRIBE_AUTOSTART=0` and `HYDRA_TRANSCRIBE_ENABLED=0` turn parts off. Details: [`transcribe-server/README.md`](../transcribe-server/README.md).

## Tools

The MCP tools a session has: `reply` (`chat_id` + `text`; `reply_to`, `files` up to 10 × 25 MB; long text is chunked), `react`, `edit_message`, `fetch_messages` (up to 100), `download_attachment`, `create_thread`, and `spawn_session`, `list_sessions` and `kill_session` for a thread owner (`kill_session` ends only sessions it spawned; main may end any; `destroy: true` also deletes the thread). Restricted specialists have a smaller set ([specialists.md](specialists.md)).

## Sessions

| Command | Action |
|---|---|
| `spawn: <topic>` | New session with a thread |
| `kill: <name>` / `kill +d` | Kill a session by name / kill this thread's session and delete the thread |
| `/sessions` | List active sessions |
| `listen` / `pause` | Toggle auto-routing in a session thread |
| `watch [pr-url]` | Watch a PR (polled every 3 minutes); review feedback and CI failures arrive in the thread, and `+green` also posts when CI passes. `unwatch <pr-url>` stops, `watches` lists |
| `help` | All commands |

Sessions get names (spark, pixel, nova…), run in their own tmux sessions, and survive daemon restarts.

- **Idle reaping:** an ephemeral session (`hydra spawn --ephemeral`, every `jobs.toml` spawn) is nudged after 30 minutes with no one posting and ended 5 minutes later. `HYDRA_IDLE_REAP_DAYS=<days>` in `.env` does the same for every other spawned session, except specialists' and protocol runs'; it is off by default. Only that idle reap keeps the record and worktree, so `resume` in its thread continues it; an ephemeral session's worktree is destroyed.
- **Usage alerts:** account-wide Claude rate-limit alerts go to the default channel (5-hour window at 80% and 95%, weekly at 80%, 90% and 95%, once per threshold).
- **Session environment:** each session has `HYDRA_SESSION_ID`, `HYDRA_SESSION_NAME`, `HYDRA_THREAD_ID` and `HYDRA_SESSION_TYPE`, so a hook can find its thread without calling the daemon.
- **More:** [schedules](schedules.md), [handoff](handoff.md), [forking](forking.md), [Google models (`spawn neon:`)](agy.md), [Slack connector](slack-connector.md).

### Exit codes and result words

Exit codes of `hydra` commands and the result words `hydra deliver` prints: [exit-codes.md](exit-codes.md).

## Troubleshooting

Symptoms first. A first-machine checklist is in [ONBOARDING_TIPS.md](ONBOARDING_TIPS.md).

- **Bot is online but `spawn:` does nothing.** Commands fire only for the `operator` in `hydra.toml`. Run `hydra migrate <platform> --operator <your user id>`, or check `operator` and that person's `addresses`. The daemon logs `command-shaped message from non-allowlisted sender …`.
- **A session hangs on a theme picker, login or "trust this folder" screen.** The byte uses `$CLAUDE_CONFIG_DIR/.claude.json` (not `~/.claude.json`), and a fresh config dir hits first-run gates. Complete them once with `tmux attach -t <platform>-byte`; `hydra preflight` flags it.
- **Bot connects but never sees messages.** Enable **Message Content Intent** (Developer Portal → Bot → Privileged Gateway Intents).
- **A session's bridge never connects.** Claude Code keeps `mcp-needs-auth-cache.json` and skips a server it lists for about 15 minutes. The daemon clears the bridge's entry before each launch; for the byte, delete the key by hand and restart.
- **Byte dies at once, or spawns fail.** Check `SPAWN_CWD` is an existing directory; read `~/hydra-<platform>-byte.log` and `~/hydra-<platform>-daemon.log`.
- **`usage` shows `?` or disagrees with your statusline.** The daemon reads context from the session's transcript, and falls back to the `hydra: ctx: N%` footer that hydra's mod prints. `?` means neither was available. A statusline that rescales reads higher.
- **Verify inbound end to end:** `grep -E "main bridge connected|running tmux new-session" ~/hydra-<platform>-daemon.log`

Logs: `~/hydra-<platform>-daemon.log` and `~/hydra-<platform>-byte.log`. The code is laid out by tier in [concepts.md](concepts.md).
