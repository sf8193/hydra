# Forking sessions

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
