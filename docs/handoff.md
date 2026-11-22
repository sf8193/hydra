# Handoff

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

## Context lines

Every percent below is a share of the session's context window, read one way everywhere (from the transcript; after a `/model` switch, from Claude Code's own `ctx: N%` footer, since the transcript cannot name the new window): the latest turn's input plus cache-creation plus cache-read tokens over the window of the model the session launched with (1M for a `[1m]` model, else 200k), as `usage` and `hydra list` show it. The README's `ctx: N%` footer is the same figure while the session runs on its launch model; `88%` in its examples is only the shape of the footer, not a recommended line.

| Line | Default | What happens | Set by |
|---|---|---|---|
| Alert | 50% and 70% | The operator is told once per climb: `X is at N% context, at its L% alert line.` The message adds what hydra will do on its own at the full line, when that is on. | fixed |
| Converge nudge | off | The session is told to start converging toward a handoff. | `AUTO_CONVERGE_PCT` |
| Cache handoff | off; 50%, idle 50 min | An idle Claude session is asked to hand off while its prompt cache is warm. | `AUTO_HANDOFF_CACHE=1` |
| Full handoff | off; 85% | An idle session is asked to hand off (or restarted fresh, per its `handoff_protocol`). | `AUTO_HANDOFF_FULL=1`, `AUTO_HANDOFF_FULL_PCT`, a specialist's `handoff_at_pct` |

The lines live in `shared/context-lines.ts`.

## Automatic handoff

Off by default. Each is set in the state dir's `.env`, which the daemon reads at startup, so a change takes a restart; the 5-minute health poll notices a session crossing a line within 5 minutes. A percent is a whole number 1–99; anything else turns the converge nudge off and keeps the full handoff at 85.

- `AUTO_CONVERGE_PCT=<percent>`: when a session's context reaches this, it is told once to start converging toward a handoff: finish or park side work, and write down what it learned where its successor will read it. It is told, not asked to hand off, so it may be mid-task, and only a session owner with a connected bridge and no protocol run is told. It is told again after its context drops below the line and climbs back, and after a daemon restart. It isn't told if it has already been asked to hand off automatically since its context reached the line. A session that starts above the line, such as a fork, is told on the first poll.
- `AUTO_HANDOFF_FULL=1`: an idle session at 85%+ context is asked to hand off, exactly as if `handoff` had been typed, before it is too full to answer anything. `AUTO_HANDOFF_FULL_PCT=<percent>` moves the line. One specialist can have its own line instead: `handoff_at_pct = <percent>` in its `[specialists.<name>]` gives its sessions the full handoff at that line, whether or not `AUTO_HANDOFF_FULL` is set and whatever `AUTO_HANDOFF_FULL_PCT` says. It is read on each health poll, so an edit to hydra.toml reaches running sessions within 5 minutes, with no restart; it is not part of the launch policy, so changing it never marks a session as drifted. Its old name, `handoff_at`, is a load error that names the new one.

  What happens at the line (and at the cache line below) is the specialist's `handoff_protocol`. `"letter"`, the default, is the ask above. `"kill_and_respawn"` asks nothing: an idle session at the line is ended (as a handoff ends one: its PR watches, waiting messages and bound Slack conversations stay with the thread) and the specialist is refilled in the same thread from its kickoff, with no letter, as a new session (not one told to continue where the old one left off); a busy one waits until it is idle. Before the kill, its conversation is marked in the thread's history as restarted fresh, so no revive (this refill, a later one, `resume`, `respawn`, boot recovery, one after a daemon restart mid-swap) resumes or forks it; a session with no history entry to mark is left running. A per-conversation specialist's session is refilled under its own name, in its own thread. The thread stops pointing at the old session before the kill, so an operator's message in a shared specialist's thread while the swap runs is held for the specialist and delivered to the fresh session; a delivery to the specialist (a Slack conversation's included) waits on its lock and lands in the fresh one. An operator's message typed in a per-conversation session's thread during the swap is not held (that thread is not a specialist's). The `handoff` command does the same, when the session is idle (it is refused while the session is busy, and it refuses a model or a note: no letter carries them), and the converge nudge is never sent: there is nothing to converge toward. A restricted or write-confined specialist's sessions have no handoff tool, so a line on one (`handoff_at_pct`) loads only with `kill_and_respawn`, and the `handoff` command asking such a session for a letter is refused with that fix.
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
