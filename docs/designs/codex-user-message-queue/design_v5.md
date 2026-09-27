# Design v5: final interrupt ownership correction

`design_v4.md` remains the complete design. This document replaces only its
interrupt-record shape and `!` routing pseudocode below; all other v4 constraints,
flows, audits, tests, rollout, and out-of-scope statements remain authoritative.

## Stable per-turn interrupt record

```ts
type InterruptRecord = {
  target: { type: 'pending-start' } | { type: 'turn'; turnId: string }
  promise: Promise<void>
  resolve: () => void
  reject: (error: Error) => void
  status: 'waiting-for-turn' | 'dispatching' | 'acknowledged'
}
```

The scheduling object owns at most one record for the current/pending turn.
Acknowledgement changes its status but does not clear it. Matching
`turn/completed` clears it. Interrupt failure rejects and clears it, allowing a
later explicit `!` to retry.

## Corrected bang flow

```text
route !message after resolving target session:
    // Synchronous call: capture a stable promise before ingress task serialization.
    interruptPromise = adapter.interrupt(session)
    reserveUserIngress(sessionId, async () => {
        try await interruptPromise
        catch log failure
        payload = await buildNotificationPayload(stripped, effectiveChatId)
        send as next-turn and arm reply guard
    })

requestInterrupt(sessionId):
    scheduling = getOrCreateScheduling()
    if interruptRecord exists for current/pending turn:
        return interruptRecord.promise
    if currentTurnId exists:
        create record targeted to that turn; dispatch RPC once; retain after ack
    else if starting/uncertain/turnPending:
        create record targeted pending-start; dispatch once ID becomes known
    else:
        return resolved no-op promise

when turn ID becomes known:
    bind pending-start record to that turn ID and dispatch one RPC

on matching turn/completed:
    clear active turn and its acknowledged interrupt record; drain FIFO
```

## Final case correction

- Two or more `!` messages targeting the same active, starting, or uncertain turn
  share one promise and cause exactly one interrupt RPC.
- Each stripped message still reserves its own ingress slot in arrival order.
- A `!` arriving after matching completion targets the next turn independently.
- The mutation test requires two bang handlers to be admitted before the start ID
  is learned, then proves one RPC and two ordered stripped-message turns.

Regressions: 0. Gaps: 0, pending final peer approval.
