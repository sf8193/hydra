# Codex command recovery

`respawn` retains the previous provider and resolved model. An explicit alias,
such as `respawn astra` or `respawn sol: continue`, selects both. Existing topic
and template syntax still works. A legacy zero-message Claude replacement whose
model was `codex-default` is skipped when selecting the recoverable conversation.

`resume` repairs the interactive surface when the Codex execution is alive.
A missing tmux window does not authorize replacing a live server. When execution
has stopped, native resume retains the saved Codex thread and home. Kill waits
for the old socket to stop accepting connections before releasing ownership.

Native fork uses a separate home and server, retains conversation history, and
passes an explicit model override to the native fork request. Start, resume, and
fork report the server-resolved model. Failed fork falls back to reading the
parent chat thread explicitly.

Reconnect reconciles pending handoffs against the resumed thread's active turn.
If completion happened during disconnection, the next queued handoff can proceed
without waiting for a lost event. Explicit disconnection removes connection
ownership before closing the socket, preventing synchronous close callbacks from
starting an unwanted reconnect. Recovery instructions accompany the initial
resumed turn instead of being sent as a second model input.

## Validation

Run the ordinary suite with both state variables pointing at a temporary directory:

```sh
task_state_dir=$(mktemp -d)
HYDRA_STATE_DIR="$task_state_dir" DISCORD_STATE_DIR="$task_state_dir" bun test
```

Opt-in real-process acceptance test (requires an existing Codex login):

```sh
bun scripts/check-codex-recovery.ts --live
```

This uses a temporary HOME, isolated tmux socket, a stub chat gateway, real
app-server RPCs, and two model turns (one brief history marker and one interrupted
turn). Other initial turns are recorded without invoking the model. Checks cover
UI-only loss, refusing replacement of a live engine, native fork history and
isolation, reconnect after a missed completion, retirement fencing, kill/resume,
and kill/respawn with model continuity. Temporary state is retained for diagnosis;
owned app-servers and tmux sessions are cleaned up.

This is not a substitute for a full Discord review-protocol soak test or a host
crash test. The broader SessionRuntime/EngineAdapter migration remains separate.
