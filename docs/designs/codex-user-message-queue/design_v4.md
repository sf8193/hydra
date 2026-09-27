# Design v4: reliable queued Codex user messages

This document supersedes v1-v3.

## Claim and approved behavior

Once the router resolves a target session, every ordinary message reserves a slot
in a per-session ingress FIFO before asynchronous attachment/transcription/thread
enrichment. The resulting payload enters a distinct-turn engine FIFO. All starts,
including the launch prompt, use one drain gate. Only `!` creates scheduler-owned
interrupt intent; if the turn ID is not known yet, the intent waits for start
settlement or reconciliation before the stripped message is admitted.

The user approved this behavior on 2026-09-26.

## Constraints

- Normal messages never steer active turns.
- `!` means interrupt, then queue its stripped message.
- Preserve routed arrival order across asynchronous enrichment.
- No silent eviction; one start in flight; launch prompt is item zero.
- Attachment paths survive every state.
- Unknown starts are reconciled, never blindly replayed.
- Claude and automated/protocol behavior remain unchanged.
- Unrelated dirty files remain untouched.
- Full daemon/host-restart durability is out of scope.

## State

```ts
type Scheduling = {
  deferredTurnQueue: string[]
  steerQueue: string[]
  fenced: boolean
  draining: boolean
  startState: idle | starting(text) | uncertain(text)
  interruptIntent: null | {
    promise: Promise<void>
    resolve: () => void
    reject: (error: Error) => void
    dispatching: boolean
  }
}

const userIngressTails = new Map<sessionId, Promise<void>>()
```

Multiple `!` callers while the same start is unresolved share one interrupt intent
and one acknowledged app-server interrupt. Each stripped message keeps its own
ingress position and proceeds after that shared intent settles.

## Authoritative flow

```text
reserveUserIngress(sessionId, task):
    previous = userIngressTails[sessionId] ?? resolvedPromise
    run = previous.catch(log).then(task)
    userIngressTails[sessionId] = run.finally(remove only if still current)
    return run

route ordinary message after resolving target + effectiveChatId:
    return reserveUserIngress(sessionId, async () => {
        payload = await buildNotificationPayload(msg, effectiveChatId)
        transport.sendOrQueue(sessionId, {
            content: payload.content,
            allowPiggyback: true,
            deferUntilTurnComplete: true,
            meta: payload.meta,
        })
        notePendingReply(...)
    })

route !message:
    strip bang and synchronously reserve the same ingress FIFO
    task:
        try await adapter.interrupt(session)
        catch log failure
        payload = await buildNotificationPayload(stripped, effectiveChatId)
        send as next-turn and arm reply guard

launch(prompt):
    queueTurn(sessionId, prompt) before connect/fork
    establish thread, then invoke shared drain gate

adapter deliver(next-turn):
    enrich attachment metadata first
    return engine.queueTurn synchronously (no connection polling)

queueTurn:
    get/create scheduling; reject if fenced
    append FIFO; invoke drain gate; return truthful accepted

drainQueuedTurns:
    only start when connected thread exists, scheduler is idle/not uncertain,
    no current turn, no pending start, and queue nonempty
    move one head to starting ownership and issue one turn/start
    acknowledged: idle state; currentTurnId blocks later drain
    explicit reject: bounded same-head retry; restore to head on exhaustion
    unknown: uncertain ownership; reconcile with thread/resume
    finally: clear pending/reentrancy state and invoke gate if eligible

reconcile unknown:
    active turn: set currentTurnId, idle startState, dispatch interrupt intent
    no active turn: idle startState, resolve interrupt intent as no-op, drain FIFO
    failure: retain uncertain state; reject interrupt waiter only when recovery is
             declared stalled/terminal, and surface stalled state

interruptActiveTurn:
    if currentTurnId exists: dispatch one acknowledged turn/interrupt request
    else if startState is starting/uncertain or turnPending:
        create/reuse interruptIntent and return its promise
    else: resolve no-op

after start acknowledgement / turn ID learned:
    dispatch pending interrupt intent exactly once
    keep currentTurnId active after interrupt acknowledgement
    resolve interrupt promise, but wait for matching turn/completed before drain

after explicit start rejection/no active reconciliation:
    resolve pending interrupt intent as no-op

turn/completed:
    ignore identified stale completion
    clear matching active turn
    drain only through shared gate
```

## Why peek can look finished

Rendering the final answer precedes the app-server completion commit point. A
comment during this interval is already ingress-owned, then engine-FIFO-owned,
and waits for `turn/completed`; it is never steered into the stale turn.

## Audit

| Case | Verdict |
|---|---|
| Idle connected | intentional next turn |
| Active / visibly finished but completion pending | fixed |
| Start pending / completion race | fixed by drain gate |
| Burst / 51+ | fixed, no eviction |
| Attachment A then plain B | fixed by pre-enrichment ingress reservation |
| `!` active | fixed, acknowledged request then completion commit |
| `!` during starting | fixed by interrupt intent |
| `!` during uncertain reconciliation | fixed by interrupt intent |
| Multiple `!` during same unresolved start | fixed, shared one-shot interrupt |
| Disconnected / reconnect | fixed, synchronous engine scheduling ownership |
| Launch/fork prompt ordering | fixed, prompt item zero |
| Resume idle/active | fixed |
| Explicit rejection | same semantics, ownership explicit |
| Unknown start | fixed with uncertain block/reconciliation |
| Fenced | truthful rejection |
| Both router paths/effective chat ID | fixed by shared reservation helper |
| Claude / automated protocol | unchanged |

Regressions: 0. Gaps: 0, pending peer approval.

## Mutation-sensitive proof

1. Both router branches use ingress reservation and next-turn mode.
2. Gate attachment enrichment for A, route plain B, prove A/B delivery order.
3. Initial prompt remains ahead of any preconnection user work.
4. Disconnected A then connected B stays A/B with attachments intact.
5. 51+ messages remain exact FIFO.
6. Connect, fork, resume-idle drain; resume-active waits.
7. Completion during pending start cannot overlap starts.
8. Explicitly rejected A never lets B overtake it.
9. Unknown A blocks B; reconciliation resumes once without replaying A.
10. Active `!`: interrupt acknowledgement precedes message enqueue, but queued
    work does not start before old completion.
11. `!` during starting and uncertain: exactly one interrupt dispatches when the
    ID becomes known, before stripped-message admission.
12. Multiple pending `!` calls share one interrupt RPC.
13. Fence reports rejection, not acceptance.

## Rollout and out of scope

Implement as verified steps, compile daemon/CLI/bridge entrypoints, and run the
full suite. Daemon restart/deployment is a separate explicit action.

Out of scope: disk outbox across daemon/host restart, server steering changes,
Claude interruption redesign, and reply-guard timing.
