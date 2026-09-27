# Design: reliable queued Codex user messages

## Claim

This design fixes user comments being lost or injected into stale Codex turns by
making every ordinary user message a distinct FIFO next turn. It does not yet
provide crash-proof delivery across a full daemon restart.

## Constraints and user decisions

- 2026-09-26: ordinary user messages must queue as next turns.
- 2026-09-26: `! message` retains its interrupt meaning, then queues the message.
- User messages must not be silently discarded to enforce a queue cap.
- Preserve Claude delivery behavior and automated/protocol delivery behavior.
- Avoid duplicate execution when `turn/start` has an unknown outcome.
- Existing unrelated dirty files (`daemon.ts`, `daemon/plugin-manifest.ts`, and two scripts) must not be touched.

## Rejected ideas

- Keep automatic mid-turn steering for ordinary comments: rejected because it is
  unacknowledged and races the visible end of a turn.
- Infer idleness from the TUI/peek output: rejected because app-server events own
  turn state; terminal rendering is not an execution commit point.
- Retry an unknown `turn/start` outcome automatically: rejected because it can
  execute the same user request twice.

## Movement

| Today | New home |
|---|---|
| Router omits delivery mode for real user messages | Router explicitly sets `deferUntilTurnComplete: true`. |
| `!` starts interrupt asynchronously and sleeps 50 ms | Await the adapter interrupt, then route with next-turn semantics. |
| `queueTurn` requires a live connection | Session scheduling accepts text without a connection; reconnect attaches and drains it. |
| Queue cap drops oldest item | No destructive cap for user/deferred turns. Operational visibility can warn on depth. |
| Default adapter path steers | Retained for explicit `steer-active` only; ordinary router calls never use it. |

## Pseudocode

```text
deliverToSession(message, target):
    payload = buildNotificationPayload(message)
    sendOrQueue(target, {
        type: notification,
        content: payload.content,
        allowPiggyback: true,
        deferUntilTurnComplete: true,
        meta: payload.meta,
    })
    armReplyGuard(payload.meta)

on !message:
    try await adapter.interrupt(session)
    catch log failure
    deliverToSession(messageWithoutBang, session)

queueTurn(sessionId, text):
    scheduling = getOrCreateScheduling(sessionId)
    if scheduling.fenced: reject
    scheduling.deferredTurnQueue.push(text)
    conn = connections.get(sessionId)
    if no conn/thread or active/pending: return accepted/queued
    drainNext(conn)

on connect/resume:
    attach scheduling queues to connection
    reconcile current active turn
    if idle and deferred queue nonempty: drainNext(conn)

on turn/completed:
    clear active turn
    if deferred queue nonempty: drainNext(conn)
    else emit turnCompleted
```

## Rollout

1. Pin router semantics and engine queue cases with focused tests.
2. Make the in-process queue authoritative for user comments.
3. Compile all entrypoints and run the complete suite.
4. Restart the Hydra daemon only after the user chooses deployment timing.

## Out of scope

- Durable outbox surviving daemon process loss or host reboot.
- Server-level steering acknowledgements.
- Changes to Claude sessions.
- Changes to automated piggyback/backstop policy.
- Changing reply-guard timing.

## Open questions

None for this increment. Durable restart delivery should be a separate change.

