# Design discussion: reliable queued Codex messages

Append-only. Participants: dusk (designer), independent peer (reviewer). The
user decides; nothing is final until the user signs off.

Files: `design.md`, `matrix.md`, `audit.md`, `HANDOFF.md`.

## dusk — 1

Proposal: route all ordinary user messages as FIFO next turns; retain `!` as an
awaited interrupt followed by the same queued delivery. Extend scheduling so a
temporarily disconnected Codex session can accept a queued turn. Remove silent
oldest-message eviction. Do not replay unknown `turn/start` outcomes.

Questions for the peer:

1. Does any router branch still let a normal user message reach `turn/steer`?
2. Can completion/start/reconnect races reorder or strand queued messages?
3. Is awaiting `interrupt()` sufficient for `!`, given each adapter's contract?
4. Which test mutations would prove the fix rather than merely exercise it?

## peer — 1

Verdict: reject pending design changes.

1. The router has a second ordinary-message fallback at `router.ts:1003-1027`
   that bypasses `deliverToSession` and would still steer.
2. Adapter polling can reorder a first disconnected message behind a later
   message; it also queues before attachment enrichment.
3. Completion can drain while `turnPending` is true, allowing concurrent starts.
   An unknown start outcome also strands later messages without an explicit
   blocked/reconciliation state.
4. `interrupt()` only spawns `tmux send-keys Escape`; awaiting it is not a Codex
   app-server acknowledgement. Retirement's acknowledged interrupt cannot be
   reused because it fences and clears scheduling state.
5. Queue acceptance is not truthful when disconnected/fenced, and initial
   connect/fork do not drain pre-connection scheduling.

Required proofs: cover both router sites; gate `!` on an acknowledged interrupt;
test reconnect ordering and attachments; enqueue 51+ items; exercise connect,
resume-idle, resume-active, and fork; force completion during pending start;
prove explicit-rejection FIFO; and prove unknown-outcome blocking plus recovery.

## dusk — 2 (user decision: 2026-09-26)

User approved: ordinary messages queue as next turns and only `!` interrupts.
Adopted every peer finding in `design_v2.md`. In particular, v2 centralizes both
router paths, makes enqueue synchronous before connection work, introduces one
serialized drain gate plus explicit uncertain state/reconciliation, and adds a
non-retiring acknowledged Codex interrupt.

## peer — 2

Verdict: reject pending two lifecycle clarifications.

1. Connect/fork draining can race the launch prompt, which is currently started
   afterward outside the scheduler (`codex-engine-adapter.ts:57-89`). The prompt
   must enter the same FIFO before thread establishment.
2. Interrupt acknowledgement is not turn completion. Clearing the active ID and
   draining immediately lets a late completion clear a newer turn. Retain the
   interrupted turn as active until its completion event.
3. The shared router helper must accept the effective `chatId`; mapped and fallback
   paths compute it differently.

## dusk — 3

Adopted all peer-2 findings in `design_v3.md`: the launch prompt is FIFO item zero,
Codex interrupt acknowledgement does not clear/drain the active turn, and the
shared router helper takes an explicit effective chat ID.

## peer — 3

Verdict: reject pending two final ordering cases.

1. Async attachment download/transcription/thread lookup happens before engine FIFO
   admission, so a later cheap message can overtake an earlier enriched message.
2. `!` during a pending or uncertain start sees no `currentTurnId` and returns;
   it needs durable interrupt intent that fires when the turn ID becomes known.

## dusk — 4

Adopted both findings in `design_v4.md`: a per-session ingress tail reserves
message order before payload enrichment, and scheduler-owned interrupt intent
waits through start settlement/reconciliation before the stripped message enters
the same ingress FIFO.

## peer — 4

Verdict: reject one exact blocker. Because `interrupt()` runs inside the serialized
ingress task, a second `!` cannot share the first intent until after task one
finishes and would issue a duplicate interrupt against the same still-active turn.

## dusk — 5

Adopted in `design_v5.md`: each bang synchronously captures a stable per-turn
interrupt promise before its ingress task runs. The interrupt record survives
acknowledgement through matching completion, so later bangs for the same turn
reuse it without another RPC.

## peer — 5

Verdict: reject one retry-boundary gap. A pending-start interrupt cannot resolve
as a no-op on the first explicit `turn/start` rejection because bounded retry may
still create the target turn.

## dusk — 6

Adopted in `design_v6.md`: pending-start interrupt ownership spans the entire
bounded retry lifecycle and resolves no-op only after exhaustion with no active
turn, or reconciliation proves no active turn will be retried.

## peer — 6

Verdict: reject one scheduler-state blocker. After retry exhaustion, restoring the
head and setting idle lets the stripped bang enqueue restart it immediately; the
state machine needs an explicit stalled gate and recovery transition.

## dusk — 7

Adopted in `design_v7.md`: retry exhaustion enters explicit `stalled`, every
ordinary enqueue preserves ownership without draining, and only successful
reconnect/thread reconciliation or an explicit operator resume clears the gate.

## peer — 7

Verdict: reject one precise recovery omission. Active-turn reconciliation must
also clear `stalled` to idle before waiting, or matching completion cannot drain.

## dusk — 8

Adopted in `design_v8.md`; both active and idle successful reconciliation branches
clear `stalled`, with active completion subsequently draining the preserved FIFO.

## peer — 8

Verdict: approve. Re-audited the v4-v8 state chain; both stalled-recovery branches
now clear the gate, and there are no remaining gaps or regressions.
