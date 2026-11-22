# Handoff

`handoff [model][: note]` in a session thread asks the live session to write a handoff file and call the `handoff` tool. A fresh session then continues in the same thread, worktree and label, optionally on another model. The note goes after a colon (`handoff opus: watch the open PRs`; a spaced dash works too). The outgoing session carries it into its Next action, and the successor's prompt quotes it word for word. Chat that merely starts with the word (`handoff-related bug`) is never a command.

Four optional files in the state dir change what each side is told. They are re-read on every use, and a missing, empty or unreadable one uses the built-in text:

- `actions/handoff/departing.md` replaces what the outgoing session is told. It must tell the session to write the file and call `handoff` with `path=` (usually `{{artifact}}`), or no handoff happens, and it should include `{{note}}`.
- `actions/handoff/arriving.md` replaces the arrival behavior (the Reception note, the greeting, starting the Next action at once).
- `actions/handoff/notice.md` replaces the message the thread sees when a handoff is requested.
- `actions/handoff/converge.md` replaces the converge nudge below (placeholders `pct`, `then`, `full`, `session`).

`{{name}}` placeholders: `artifact`, `session`, `cwd`, `worktree`, `branch` and `note` in departing, notice and arriving text; `requester`, `model` and `label` in departing and notice; `from`, `from_session` and `from_transcript` in arriving only. Unknown placeholders are left as written.

## Context lines

A percent is a share of the session's context window, read from the transcript (after a `/model` switch, from Claude Code's own `ctx: N%` footer): the latest turn's input plus cache tokens over the launch model's window (1M for a `[1m]` model, else 200k).

| Line | Default | What happens | Set by |
|---|---|---|---|
| Alert | 50% and 70% | The operator is told once per climb: `X is at N% context, at its L% alert line.` | fixed |
| Converge nudge | off | The session is told to start converging toward a handoff. | `AUTO_CONVERGE_PCT` |
| Cache handoff | off; 50%, idle 50 min | An idle Claude session is asked to hand off while its prompt cache is warm. | `AUTO_HANDOFF_CACHE=1` |
| Full handoff | off; 85% | An idle session is asked to hand off (or restarted fresh, per its `handoff_protocol`). | `AUTO_HANDOFF_FULL=1`, `AUTO_HANDOFF_FULL_PCT`, a specialist's `handoff_at_pct` |

The lines live in `shared/context-lines.ts`.

## Automatic handoff

Off by default. Set in the state dir's `.env` (a change takes a restart); a percent is a whole number 1 to 99. Only a session owner with a connected bridge, no protocol run and no pending permission is asked, and a request unanswered after 3 minutes is repeated once.

- `AUTO_CONVERGE_PCT=<percent>`: at that context a session is told once to finish or park side work and write down what it learned. It is told again after its context drops below the line and climbs back.
- `AUTO_HANDOFF_FULL=1` (line `AUTO_HANDOFF_FULL_PCT`, default 85) asks an idle session to hand off exactly as if `handoff` had been typed. One specialist can set its own line with `handoff_at_pct`, applied within 5 minutes of a `hydra.toml` edit.
- A specialist's `handoff_protocol` says what happens at a line: `"letter"` (the default) asks for a handoff letter; `"kill_and_respawn"` ends an idle session and refills the specialist in the same thread from its kickoff, with no letter, and marks the old conversation so nothing resumes it.
- `AUTO_HANDOFF_CACHE=1` asks a Claude session at 50%+ context, untouched for 50 minutes, to hand off while its prompt cache is warm.
- `HYDRA_TYPED_DELIVERY_USER_IDS` and `HYDRA_TYPED_DELIVERY_MODE=off|paste|hold` control how a trusted sender's message reaches a session that is mid-turn, because Claude Code frames a channel message absorbed into a running turn as "NOT from your user". `paste` types it into the pane at once; `hold` queues it until the session is idle (cap `HYDRA_TYPED_DELIVERY_HOLD_MAX_S`, 120 s). Default `off`.

Example: `AUTO_CONVERGE_PCT=50`, `AUTO_HANDOFF_FULL=1` and `AUTO_HANDOFF_FULL_PCT=70` nudge at 50% and hand off at 70%.

## Hooks

`hooks/on-kill` in the state dir runs on every kill, including a handoff (`HYDRA_KILL_REASON='handed off'`).

`hooks/pre-handoff` runs before a handoff and can refuse it; use it to check your own definition of done. It must be executable. It gets the letter's absolute path as its first argument, the `HYDRA_*` identity variables and `HYDRA_CWD`, and runs in the session's directory. Exit 0 lets the handoff go ahead. Any other exit refuses it: the session is not killed and gets `handoff refused by hooks/pre-handoff:` plus the last 1,500 characters of the hook's output. A hook that runs past 15 seconds, cannot start, dies from a signal or exits 126 or 127 fails open, so a broken script never traps a session. Every run logs one daemon line with its outcome (`pass`, `refused` or `fail-open`).

```sh
#!/bin/sh
grep -q '^#* *Next action' "$1" || { echo "letter has no Next action heading"; exit 1; }
```
