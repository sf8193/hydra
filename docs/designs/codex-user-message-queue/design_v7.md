# Design v7: explicit stalled queue state

This correction completes v4-v6.

```ts
type StartState =
  | { type: 'idle' }
  | { type: 'starting'; text: string }
  | { type: 'uncertain'; text: string }
  | { type: 'stalled'; reason: string }
```

After bounded explicit-rejection retries are exhausted:

1. Restore the owned text to FIFO head.
2. Set `startState = stalled(reason)`.
3. Resolve a pending-start interrupt intent as a no-op because no active turn was
   created by the complete retry lifecycle.
4. Emit `turnStalled` with the reason.
5. Accept later messages into FIFO, but `drainQueuedTurns` returns while stalled.

Recovery is explicit and observable:

- A successful adapter reconnect plus `thread/resume` reconciliation calls
  `resumeStalledQueue(sessionId)`. If an active turn exists, it becomes current and
  the queue waits; if none exists, state becomes idle and the FIFO head retries.
- An operator-facing reconnect/recover action uses that same path.
- Ordinary enqueue never clears stalled state.
- Retirement/fencing still clears work according to existing lifecycle semantics.

Mutation proof: exhaust A's retries, enqueue stripped bang text B, and assert no
new start. Then invoke successful resume reconciliation and prove A starts before B.

Regressions: 0. Gaps: 0, pending final peer approval.
