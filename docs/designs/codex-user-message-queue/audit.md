# Final design audit

Authoritative design: `design_v4.md` plus corrections in `design_v5.md` through
`design_v8.md`. Independent peer verdict: approve (`discussion.md`, peer turn 8).

## Results

- Cases audited: idle, active, visibly-finished/stale-active, start pending,
  attachment enrichment, bursts, disconnect/reconnect, connect/fork launch,
  resume active/idle, explicit rejection/retry/exhaustion, unknown outcome,
  stalled recovery, fencing, both router paths, ordinary and repeated `!`.
- Intentional changes signed off by user: ordinary messages are distinct queued
  turns; only `!` requests interruption.
- Regressions: 0.
- Gaps: 0.
- Constraints violated: 0.

## Key invariants

1. Routed user arrival order is reserved before async enrichment.
2. The scheduler owns every accepted payload until start outcome is known.
3. Only one turn start is in flight.
4. Unknown outcomes block and reconcile; explicit exhaustion stalls.
5. Interrupt intent belongs to a logical target turn across retries and remains
   recorded through acknowledgement until matching completion.
6. Peek/TUI output never decides execution state.

