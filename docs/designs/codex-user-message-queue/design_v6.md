# Design v6: retry-bound interrupt ownership

This is the final correction to `design_v4.md` plus `design_v5.md`.

A pending-start interrupt record belongs to the logical queued head, not to one
physical `turn/start` RPC attempt.

```text
start head A, attempt 1:
    explicit rejection and retries remain:
        keep A in starting ownership
        keep pending-start interrupt record unresolved
        issue bounded retry

    retry succeeds with turn ID:
        bind interrupt record to ID
        dispatch exactly one interrupt RPC

    all retries explicitly rejected:
        restore A to FIFO head
        resolve pending-start interrupt as no-op
        stripped bang message may enter behind A
        emit stalled; no automatic new attempt starts until recovery/operator action

    unknown outcome:
        retain interrupt record through uncertain reconciliation
```

Mutation proof: arrange `!` during attempt one, reject attempt one explicitly,
let retry succeed, and assert the same interrupt promise remains pending until one
interrupt targets the retry-created turn before the stripped message is admitted.

Regressions: 0. Gaps: 0, pending final peer approval.
