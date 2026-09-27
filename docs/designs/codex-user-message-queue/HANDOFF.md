# Handoff: reliable queued Codex messages

## TL;DR

The design is converged and peer-approved. Normal chat messages must reserve a
per-session ingress slot before payload enrichment, then enter a distinct-turn
Codex FIFO. `!` captures stable interrupt intent and queues its stripped message.
The scheduler serializes launch, reconnect, retry, uncertainty, interruption, and
completion. Peek is deliberately irrelevant to turn ownership.

## Files

- `matrix.md`: baseline cases and branch map.
- `design_v4.md`: complete design.
- `design_v5.md`-`design_v8.md`: authoritative corrections.
- `audit.md`: final case audit.
- `discussion.md`: append-only peer critique and approval.

## Constraints and rejected ideas

- Do not touch existing unrelated dirty files: `daemon.ts`,
  `daemon/plugin-manifest.ts`, `scripts/jev-routing-backtest.ts`, or
  `scripts/jev-swebench-eval.ts`.
- Do not use automatic steer for normal comments or TUI output for idleness.
- Do not silently evict user messages or blindly retry unknown starts.
- Do not reuse destructive retirement for `!`.
- Disk-backed daemon-restart durability is a later increment.

## Decisions log

- 2026-09-26: user approved ordinary messages as distinct queued turns.
- 2026-09-26: user approved retaining `!` as the sole interrupt mechanism.
- 2026-09-26: peer approved the final v4-v8 design after eight audit rounds.

## Open items

- Implementation and verification only; no product decision remains.
- Restart/deploy of the live Hydra daemon requires a separate explicit action.

## Proposed verified-step plan

### Step 1 — engine scheduler and adapter contract

Files: `daemon/codex-engine.ts`, `daemon/engines/codex-engine-adapter.ts`, focused
Codex tests. Add scheduler state, truthful queue acceptance, launch item zero,
serialized drain/retry/reconciliation/stall recovery, and stable acknowledged
interrupt ownership.

Exit: focused tests prove FIFO, 51+ retention, connect/fork/resume behavior,
pending/completion races, unknown/rejected/stalled paths, and interrupt lifecycle;
daemon entrypoint compiles.

### Step 2 — router ingress serialization

Files: `daemon/router.ts` and focused router/transport tests. Route both ordinary
message paths through per-session ingress reservation and next-turn delivery;
capture `!` interrupt promise before its serialized enrichment task.

Exit: mutation-sensitive tests prove attachment A cannot be overtaken by B, both
router paths choose next-turn, and repeated/pending bangs preserve order.

### Step 3 — integration verification

No intended production changes. Run focused suites repeatedly, full suite, and
compile daemon, CLI, and bridge entrypoints. Adversarially review the combined
diff. Do not restart the daemon.

Exit: all checks pass, peer review passes, unrelated dirty files remain unchanged.
