# Design v3: reliable queued Codex user messages

This document supersedes `design.md` and `design_v2.md`.

## Claim and approved behavior

Every ordinary user message is synchronously accepted into a per-session FIFO and
becomes a distinct next turn. Only `!` requests interruption. All turn starts,
including the initial launch prompt, share one serialized scheduler. An
acknowledged interrupt leaves the interrupted turn active until its completion
event, preventing late completion from clearing a newer turn.

The user approved the intentional behavior change on 2026-09-26.

## Constraints

- Normal user messages never use implicit steering.
- `! message` requests interruption, then enters the same FIFO.
- FIFO has no silent destructive cap.
- One `turn/start` in flight per session.
- Initial prompt is FIFO item zero.
- Attachment enrichment precedes enqueue.
- Unknown start outcomes are never blindly replayed.
- Preserve Claude and automated/protocol behavior.
- Existing unrelated dirty files remain untouched.
- Durable ownership across a complete daemon/host restart is a separate increment.

## Scheduler state

```ts
type Scheduling = {
  deferredTurnQueue: string[]
  steerQueue: string[]
  fenced: boolean
  startState:
    | { type: 'idle' }
    | { type: 'starting'; text: string }
    | { type: 'uncertain'; text: string }
  draining: boolean
}
```

`starting` and `uncertain` retain ownership of the removed FIFO head. Later work
cannot pass either state.

## Authoritative flow

```text
launch(prompt):
    queueTurn(sessionId, prompt)       // before connect/fork; FIFO item zero
    connect or fork thread
    drainQueuedTurns(sessionId)        // now eligible

deliverUserMessage(msg, sessionId, effectiveChatId):
    payload = await buildNotificationPayload(msg, effectiveChatId)
    transport.sendOrQueue(sessionId, {
        type: notification,
        content: payload.content,
        allowPiggyback: true,
        deferUntilTurnComplete: true,
        meta: payload.meta,
    })
    notePendingReply(sessionId, payload.meta)

mapped router path:
    await deliverUserMessage(msg, mappedSession, session.threadId)

final fallback path:
    resolve targetSessionId and effectiveChatId
    await deliverUserMessage(msg, targetSessionId, effectiveChatId)

on !message:
    try await adapter.interrupt(session)
    catch log failure
    await deliverUserMessage(stripped, session, session.threadId)

adapter deliver(next-turn):
    enriched = enrichAttachments(text, meta)
    return queueTurn(sessionId, enriched) // no connection polling first

queueTurn(sessionId, text):
    scheduling = getOrCreateScheduling(sessionId)
    if fenced: return rejected
    queue.push(text)
    drainQueuedTurns(sessionId)
    return accepted

drainQueuedTurns(sessionId):
    return unless scheduler idle, not draining/fenced, connection+thread exist,
                  no current turn, !turnPending, and queue nonempty
    pop FIFO head into startState=starting
    issue one startTurn
    explicit rejection: bounded retry of same owned head; after exhaustion put it
                        back at queue head, set idle, emit stalled
    unknown result: startState=uncertain; reconcile via thread/resume
    acknowledged result: startState=idle; active turn id prevents another drain
    finally: clear turnPending/draining and drain only if still eligible

turn/completed:
    ignore identified stale IDs that differ from currentTurnId
    clear matching current turn
    drain only through drainQueuedTurns (which checks startState and turnPending)

reconcile uncertain start:
    thread/resume
    active turn found: assign currentTurnId; uncertain text belongs to it; set idle
    no active turn: do not replay uncertain text; set idle; drain later FIFO
    reconciliation fails: retain uncertain state; emit stalled for operator action

connect / fork / resume:
    establish/reconcile thread, attach existing scheduling, invoke drain gate
    resume-active sets currentTurnId first, so drain waits

Codex interruptActiveTurn:
    if no current turn: return
    capture turnId
    await request turn/interrupt(threadId, turnId)
    DO NOT clear currentTurnId and DO NOT drain
    matching turn/completed remains the commit point and drains queued work
```

## Why peek can disagree

The TUI can display the final answer before app-server emits/processes
`turn/completed`. The design never uses peek output for scheduling; a comment in
that window is safely appended to FIFO and drains on the completion event.

## Cases and audit

| Case | Verdict |
|---|---|
| Idle connected | intentional: acknowledged next turn |
| Active or visibly-finished/stale active | fixed: FIFO waits for completion |
| Start pending or completion during start | fixed: single drain gate |
| Burst / 51+ | fixed: ordered, no eviction |
| `!` active | fixed: acknowledged interrupt request; completion is commit point |
| `!` idle | same: enqueue starts immediately |
| Disconnected | fixed: scheduler owns synchronously before connection |
| Connect/fork launch prompt race | fixed: prompt is item zero before establishment |
| Resume idle/active | fixed: same drain gate after reconciliation |
| Explicit start rejection | same semantics, FIFO ownership made explicit |
| Unknown start result | fixed: uncertain state blocks, then reconciles |
| Fenced | same behavior, truthful rejection |
| Attachments while disconnected | fixed: enriched first |
| Both router entry points | fixed: shared helper with explicit effective chat ID |
| Claude / automated protocol | unchanged |

Regressions: 0. Gaps: 0, pending final peer approval.

## Mutation-sensitive proof

1. Both router branches must fail tests if next-turn mode/helper use is removed.
2. Gated `!` interrupt: enqueue occurs after acknowledgement; rejection still
   enqueues. Codex current turn remains set until completion.
3. Initial prompt plus pre-connect messages stay in exact order.
4. Disconnected A followed by connected B stays A/B; attachments survive.
5. 51+ messages remain exact FIFO.
6. Connect, fork, resume-idle drain; resume-active waits.
7. Completion during pending start cannot overlap starts.
8. Explicitly rejected A never lets B overtake it.
9. Unknown A blocks B; successful reconciliation resumes once without replay A.
10. Fence returns rejection rather than accepted.
11. Late completion after interrupt cannot clear a newer turn because no newer
    turn starts before the interrupted turn completes.

## Rollout and out of scope

Implement in small verified steps, compile all three entrypoints, and run the full
suite. Restarting/deploying the daemon requires a separate explicit action.

Out of scope: disk-backed daemon-restart outbox, server steering redesign, Claude
interrupt redesign, and reply-guard timing.

