# Activity-Aware Protocol Timeouts

> What was built in PR #160 and why.

## The problem

A fixed 10-minute timeout fires at 10:00 regardless of whether the critic has been actively working for 9:50 or idle since 0:10. Both get the same response: cancel.

## What was built

Three communication channels replacing the blind timeout:

### 1. Warning notification (daemon → session)

2 minutes before timeout, the daemon checks `turnState`. If the session is idle, it sends a warning with the sentinel hint, context %, and instructions to post or call `extend_phase`. If the session is actively working (pane active), the warning is skipped.

After a deferral, the warning escalates — it mentions elapsed time and remaining time until the total backstop.

### 2. `extend_phase` tool (session → daemon)

The session calls `extend_phase(reason, minutes)` to request more time. The daemon resets the idle timeout, records the extension as a decision on the run, and posts a status line to the thread. Max 2 extensions per phase entry (resets each round). Only the current phase's actor can extend.

### 3. Activity-informed timeout (daemon peeks at session)

When the timeout fires, the daemon checks `turnState` one more time. A `working` session gets the timeout deferred (reset). An `idle` session gets cancelled.

### 4. Total backstop (unconditional)

A hard outer limit at 3x the phase window, set at phase entry, never reset. Fires unconditionally — no `turnState` check, no deferral. Prevents unbounded deferral from activity-based resets.

## Known limitations

- **Warning is best-effort** — delivered via `sendOrQueue`, no acknowledgment. A session with a disconnected bridge may miss the warning. The total backstop is the safety net.
- **`turnState` is 20s resolution** — polled by the health loop. A session that goes idle between polls may get a stale `working` read at warning time. Minor: the timeout still fires 2 minutes later.
- **Extensions are per phase entry, not per run** — a 5-round review with 2 extensions per round could add 50 minutes. Cumulative run time is bounded by the declared round count, not by extensions.
