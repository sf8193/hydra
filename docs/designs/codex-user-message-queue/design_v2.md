# Design v2: reliable queued Codex user messages

## Claim

Every ordinary user message entering either router path is synchronously owned by
one FIFO scheduler before any asynchronous connection work begins. Exactly one
turn start may be in flight. `!` requests an acknowledged, non-retiring Codex
interrupt and then enqueues normally. Unknown start outcomes block FIFO until a
thread-state reconciliation resolves whether an active turn exists.

This fixes in-process loss, stale-turn steering, reordering, and start/completion
races. Crash-proof delivery across a complete daemon restart remains out of scope.

## Constraints and decisions

- Ordinary user messages are distinct next turns, never implicit steers.
- `! message` retains interrupt semantics, then enters the same FIFO.
- No silent queue eviction.
- FIFO: a later message never starts before an earlier accepted message.
- Only one `turn/start` request may be in flight per session.
- Preserve attachment enrichment before ownership transfer.
- Preserve Claude and automated/protocol behavior.
- Never blindly replay an unknown start outcome.
- Do not touch unrelated dirty files.

## Rejected ideas

- Automatic steering for normal comments.
- TUI/peek-based idleness.
- Poll-for-connection before enqueue (permits overtaking).
- Automatic replay after unknown start outcome (duplicate risk).
- Reusing `retireSession()` for `!` (destructively fences and clears work).

## State

Per session scheduling exists independently of a live connection:

```ts
type Scheduling = {
  deferredTurnQueue: string[]
  steerQueue: string[]             // explicit internal steering only
  fenced: boolean
  startState:
    | { type: 'idle' }
    | { type: 'starting'; text: string }
    | { type: 'uncertain'; text: string }
  draining: boolean                // synchronous re-entrancy guard
}
```

`starting.text` is removed from the FIFO but remains scheduler-owned until the
request resolves. `uncertain.text` remains owned and blocks later messages while
Hydra reconciles with `thread/resume`. It is not automatically replayed.

## Movement

| Today | New home |
|---|---|
| Two router delivery sites choose no mode | A shared `deliverUserMessage` helper always sets `deferUntilTurnComplete: true`; both mapped and final fallback paths call it. |
| Adapter polls before enqueue | Attachment enrichment happens first; `next-turn` immediately calls `queueTurn`, even disconnected. |
| Queue requires a connection | `getOrCreateScheduling()` owns accepted text; connect, fork, and resume all invoke the same drain gate after thread establishment/reconciliation. |
| Several sites start/drain directly | `drainQueuedTurns(sessionId)` is the only scheduler start gate. |
| Unknown outcome is forgotten | Scheduler enters `uncertain`, calls thread reconciliation, and blocks FIFO until resolved or reports a stalled session. |
| `!` fires TUI Escape | Codex adapter calls a new non-retiring `interruptActiveTurn()` using acknowledged `turn/interrupt`; Claude preserves its existing provider behavior. |

## Pseudocode

```text
deliverUserMessage(msg, session):
    payload = await buildNotificationPayload(msg)
    transport.sendOrQueue(session, {
        content: payload.content,
        allowPiggyback: true,
        deferUntilTurnComplete: true,
        meta: payload.meta,
    })
    notePendingReply(...)

on !message:
    try await adapter.interrupt(session)
    catch log failure
    await deliverUserMessage(strippedMessage, session)

adapter.deliver(text, next-turn, meta):
    enriched = enrichAttachments(text, meta)
    result = engine.queueTurn(sessionId, enriched) // synchronous ownership
    return truthful accepted/rejected result

queueTurn(sessionId, text):
    scheduling = getOrCreateScheduling(sessionId)
    if scheduling.fenced: return rejected
    scheduling.deferredTurnQueue.push(text)
    drainQueuedTurns(sessionId)
    return accepted

drainQueuedTurns(sessionId):
    scheduling = ...
    conn = connections.get(sessionId)
    if draining/fenced/no conn/no thread/current turn/turnPending/
       startState != idle/queue empty: return
    draining = true
    text = queue.shift()
    startState = starting(text)
    startTurn(text)
      on acknowledged success:
        startState = idle
        // currentTurnId is now authoritative; do not start another
      on explicit rejection:
        retry same owned text with bounded backoff
        after exhaustion: queue.unshift(text); startState=idle; emit stalled
      on unknown outcome:
        startState = uncertain(text)
        reconcileThreadState()
    draining = false

on turn/completed(turnId):
    ignore stale completion when it identifies a different current turn
    clear current turn
    if startState == idle and !turnPending: drainQueuedTurns()

after start request finally settles:
    turnPending = false
    if no current turn and startState == idle: drainQueuedTurns()

reconcileThreadState():
    result = request thread/resume(threadId)
    if an in-progress turn exists:
        currentTurnId = its id
        startState = idle // uncertain text belongs to that active turn
    else:
        startState = idle // unknown text either completed or was rejected;
                          // do not replay, but later FIFO work may continue
        drainQueuedTurns()
    on reconciliation failure:
        retain uncertain state and emit turnStalled/uncertain for operator action

connect / fork / resume:
    establish or reconcile thread
    attach scheduling state
    drainQueuedTurns() only if no active turn and scheduler not uncertain

interruptActiveTurn(sessionId):
    if no active turn: return true
    await request turn/interrupt(threadId, currentTurnId)
    // do not fence or clear queues
    clear current turn only after acknowledgement
    drainQueuedTurns()
```

## Interrupt contract

- Codex: `interrupt()` means the app-server acknowledged `turn/interrupt`, or it
  rejects. It never retires/fences the session.
- Claude: unchanged TUI Escape behavior in this increment.
- Router logs interrupt failure and still enqueues the user's stripped message.
  The FIFO waits behind any still-active turn rather than losing the message.

## Audit against cases

| Case | Verdict | Reason |
|---|---|---|
| C1 idle connected | changed (intentional) | Uses explicit next-turn start. |
| C2 active | fixed | FIFO waits for completion. |
| C3 visible/stale-active race | fixed | Never steers; completion drains. |
| C4 start pending | fixed | Single drain gate refuses overlap. |
| C5 burst/51+ | fixed | FIFO without eviction. |
| C6 `!` active | fixed | Acknowledged Codex interrupt, then enqueue. |
| C7 `!` idle | same | No-op interrupt, immediate queued start. |
| C8 disconnected | fixed | Synchronous scheduling ownership before async work. |
| C9 transient reconnect | fixed | Scheduling survives in process and every establishment path drains. |
| C10 explicit rejection | same | Bounded retry; same item remains FIFO head on exhaustion. |
| C11 unknown outcome | fixed | Explicit uncertain ownership and reconciliation. |
| C12 fenced | same, truthful | Queue rejects and adapter reports rejection. |
| C13 attachments | fixed | Enrichment precedes enqueue in all branches. |
| C14 Claude | same | Shared helper flag is ignored by free bridge path; Claude interrupt unchanged. |
| C15 automated protocol | same | Existing explicit modes remain. |
| C16 final router fallback | fixed | Shared helper prevents bypass. |
| C17 completion during start pending | fixed | Serialized drain gate and finally-drain. |

Regressions: 0. Gaps: 0, pending peer re-audit.

## Required mutation-sensitive tests

1. Both router delivery paths set next-turn; removing either flag fails.
2. Gated `!` interrupt proves delivery waits; rejection still queues.
3. Disconnected A then connected B remains A/B.
4. Disconnected attachment paths survive.
5. 51+ messages remain exact FIFO.
6. Pre-connection queue drains through connect, fork, resume-idle; resume-active waits.
7. Completion during pending start cannot overlap starts.
8. Explicit rejection leaves `[A, B]` after retries.
9. Unknown A blocks B, reconciliation resumes once without replaying A.
10. Fence rejects instead of reporting accepted.

## Rollout and out of scope

Ship code and tests together, compile all three entrypoints, then run the full
suite. Daemon restart/deployment is a separate explicit action.

Out of scope: durable disk outbox across daemon/host restart, server steering
acknowledgements, Claude delivery redesign, and reply-guard timing.

