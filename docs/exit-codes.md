# Exit codes and result words

One word means "try again later, nothing is wrong": **`deferred`**. A schedule's result, a guard's verdict, `hydra schedules run` and `hydra deliver` all use it. The codes differ by who is speaking. **75 is deferred for the scripts you write** (a guard, a schedule `check`). **`hydra deliver` reports its own codes, 2 to 8**, where 5 and 7 are deferred.

**A script you write, and what hydra does with its exit code**

| Script | Exit | Word | What hydra does |
|---|---|---|---|
| `[guard]` | 0 | `deliver` | Delivers. Printed `{"target": ...}` redirects. |
| | 10 | `drop` | Never delivered; counted, not alerted. |
| | 75 | `deferred` | Stays owed, up to `owed_max`; the next catch-up pass offers it again. |
| | anything else, a timeout, over 4 KB, will not start | `open` | Delivers anyway and logs why. |
| schedule `check` | 0 with output | `done` | The output becomes the message. |
| | 0, empty | `nothing` | Nothing is sent. |
| | 75 | `deferred` | No attempt, no slot used, output dropped. |
| | anything else, will not start | `failed` | Backs off; alerts after the threshold. |
| `hooks/pre-handoff` | 0 | `pass` | The handoff goes ahead. |
| | 126, 127, a signal, over 15 s, will not start | `fail-open` | The handoff goes ahead. |
| | anything else | `refused` | The handoff stops, with the hook's last 1500 characters. |

**What `hydra deliver` tells you** (`--json` adds `result`; text mode ends the `error:` line with `[deferred]` for deferred only)

| Exit | `result` | Meaning |
|---|---|---|
| 0 | `done` | Delivered or queued. |
| 1 | `failed` | Bad request, or a delivery the daemon rejected. |
| 2 | `done` | Already delivered with this key. |
| 3 | `failed` | Gone or refused: a dead thread, a withdrawn sender, a message too large. |
| 4 | `failed` | Running, but its bridge is not connected (or `main` is not). |
| 5 | `deferred` | Booting, busy (a session the engine refused a message as transient, such as a codex turn that will not take a steer), or a per-conversation specialist at `max_sessions`. A session stuck on a dialog (`stuck: <kind>`) is `failed`: waiting does not clear it. |
| 6 | `failed` | Starting failed or is backing off, the session died during delivery, or the outcome is unknown. |
| 7 | `deferred` | A delivery with this key is still in flight. |
| 8 | `failed` | No such specialist, or a target with no kind. |
| none | no word | The daemon does not answer: exit 1 with `fatal: ...`, and no JSON. `hydra jobs` treats it as deferred. |

With `--json`, a refusal's `data` carries its flags: `permanent` (it can never be delivered, such as a message too large: drop it, never retry), `wait` (exit 5: a per-conversation specialist has no place for this conversation yet) and `malformed` (exit 8: hydra cannot read the target).

**Other commands**

| Command | Exit | Meaning |
|---|---|---|
| `hydra schedules run` | 0 | `done` or `nothing`. |
| | 1 | `failed`; also superseded, no daemon, or no answer in time. |
| | 75 | `deferred`, printed as `<name>: deferred: <reason>`. |
| | 130 | SIGINT (Ctrl-C), or a cancelled run that ended deferred. |
| every other `hydra` command | 0 / 1 | Success / `error: ...`. |
| the daemon at boot | 78 | `hydra.toml` was refused; `hydra health` shows why. |

`--json` exits 0 whenever the daemon answers, even when the command failed: read `ok` and `exitCode` in the JSON. If the daemon does not answer, it exits 1 with `fatal: ...` and no JSON (no word; `hydra jobs` treats that as deferred). Text mode exits with the code.
