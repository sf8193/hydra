# Spike — protocol

> A single-agent investigation protocol. An explorer digs into a question; the guide watches from the thread and can redirect at any time. Checkpoints keep the human oriented; the report is the deliverable.
>
> This protocol exists because not every interaction is adversarial. Sometimes the shape is: "go find out, keep me posted, come back with what you learned." The explorer has one job — genuine investigation, not performance — and the protocol's only machinery is the checkpoint cadence that keeps the human in the loop.

## Intent

Investigate a question with depth and rigor. The explorer works autonomously, posting checkpoints so the guide stays oriented. The guide can redirect focus at any time. The final report is the artifact.

## Roles

| Role | Who | Owes |
|---|---|---|
| **explorer** (The Explorer) | a fresh-genesis spawn, given a question and turned loose | posts `[checkpoint]` with progress, `[report]` with findings |
| **guide** (The Guide) | the thread's own session — the one who asked | watches, redirects with `[redirect]`, wraps up with `[wrap-up]` |

## Arc

1. **exploring** — the explorer works. Posts `[checkpoint]` periodically to keep the guide oriented. The guide can post `[redirect]` to change focus (forwarded as a system notification — not a phase transition). On `[wrap-up]` from the guide, moves to reporting.
2. **reporting** — the explorer writes a final report. On `[report]` post, the spike completes.
3. **complete** / **cancelled** — terminal.

Exploring has a long window (60 minutes) — spikes are open-ended by nature. The guide's `[redirect]` is a mid-phase notification, not a transition, because redirecting doesn't change whose turn it is — it changes what the explorer is looking at.

## Lenses

Lenses compose with spikes. A `spike +security` means: investigate from a security perspective. The lens instructions are injected into the explorer's seed. The same `protocols/lenses/` directory serves both review and spike — compose by writing.

## Report shape

The explorer's final report. Structured for a reader who wasn't watching the checkpoints.

- **🔬 Finding** — what you found, in one sentence.
- **Evidence** — what you read, what you tested, what you observed.
- **Implications** — what this means for the work.
- **Unknowns** — what you couldn't determine and why.

## Skeleton

```yaml skeleton
protocol: spike
emoji: "🔬"
display_name: Spike

roles:
  explorer: { label: The Explorer }
  guide:    { label: The Guide }

initial_phase: exploring

phases:
  exploring:
    actor: explorer
    half: top
    on: { checkpoint: exploring, wrap_up: reporting, timeout: reporting, cancel: cancelled }
  reporting:
    actor: explorer
    half: bottom
    on: { report_posted: complete, timeout: complete }
  complete:   { terminal: true }
  cancelled:  { terminal: true }

sentinels:
  exploring: "[checkpoint]"
  reporting: "[report]"

windows:
  exploring: 60m
  reporting: 10m

disconnect_grace:
  explorer: 2m

completion_event:
  protocol: spike
  fields:
    - thread
    - topic
    - outcome
    - checkpoints
    - transcript
```
