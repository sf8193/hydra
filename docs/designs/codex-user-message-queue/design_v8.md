# Design v8: stalled recovery completion

This one-line state rule completes v7:

```text
resumeStalledQueue after successful thread/resume:
    if active turn exists:
        currentTurnId = active.id
        startState = idle
        wait for matching completion; completion drains preserved FIFO
    else:
        startState = idle
        drain preserved FIFO immediately
```

Test both branches. For the active branch, recover stalled `[A, B]`, prove neither
starts while the reconciled turn is active, emit its matching completion, then
prove A starts before B.

Regressions: 0. Gaps: 0, pending final peer approval.
