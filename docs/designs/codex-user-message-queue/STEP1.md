# Step 1 — make real user messages acknowledged next turns

## Scope

- `daemon/router.ts`
- `daemon/codex-engine.ts`
- `daemon/engines/codex-engine-adapter.ts`
- focused tests only

## Required behavior

1. Both router paths mark user messages `deferUntilTurnComplete`.
2. The Codex adapter enriches attachments before enqueueing and immediately
   transfers next-turn ownership without polling.
3. The engine can accept a queued turn before/disconnected from a connection,
   never silently evicts one, and drains on thread establishment/resume.
4. Enqueue against a supposedly active turn reconciles app-server thread state,
   so a missed completion notification cannot strand the comment.
5. Existing steering remains available only for explicitly steering callers.

## Out of scope

- Live daemon restart.
- Unrelated dirty files.
- Disk persistence across daemon process loss.
- Full interrupt-intent redesign (subsequent step).

## Exit criteria

- Focused Codex and transport tests pass.
- Daemon entrypoint compiles.
- A fresh reviewer proves removal of either router flag or queue reconciliation
  breaks a test.
