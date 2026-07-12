# Build — protocol

> A dyad protocol. An owner implements; a critic reviews in bounded rounds; the owner closes with a summary of what was built. The critic is killed after the debate — it exists only to sharpen the work.
>
> Prose for the human; `skeleton` for the daemon.

## Intent

Ship working code under structured review pressure. The owner builds; a fresh critic reviews each round; the cycle repeats until LGTM or max rounds. The closing summary is the artifact — what was built, what was contested, what's next.

## Roles

| Role | Who | Owes |
|---|---|---|
| **builder** (The Builder) | the thread's own session — the one doing the work | posts implementation summaries, first line `[builder→critic]`; after the debate, posts the closing summary, first line `[summary]` |
| **critic** (The Critic) | a fresh-genesis spawn, implementation-focused | reviews each implementation, first line `[critic→builder]`; second line `**LGTM**` to approve |

## Arc

1. **implementing** — the builder works and posts an implementation summary. On a tagged post, a critic spawns (first round) or receives the update (subsequent rounds).
2. **reviewing** — the critic reviews. Three outcomes: `**LGTM**` (approved → closing), max rounds reached (→ closing), or feedback (→ back to implementing for another round).
3. **closing** — the debate is over. The builder writes one closing summary. Posting it completes the build; a 5-minute silence auto-closes it.
4. **complete** / **cancelled** — terminal. Completion preserves the transcript (dump-without-strike — build messages are the work product, not scaffolding).

A turn that goes silent past its window cancels the build. A participant whose bridge drops gets a grace period to reconnect.

## Summary shape

The builder's closing summary. Same five-movement shape as review — the protocol-level closing grammar.

- **🔨 Build Summary** — what was built, in one sentence.
- **Round Arc** — per round: what was submitted, what the critic found.
- **📋 Dispositions** — `✅ fixed · ⚠️ deferred · ❌ rebutted`, one line each.
- **⚡ Tensions** — the real disagreements, not just the list of findings.
- **🌱 What Emerged** — design insights that came from the friction.
- **➡️ What's next** — what ships, what needs the human.

## Skeleton

```yaml skeleton
protocol: build
emoji: "🔨"
display_name: Build

roles:
  builder: { label: The Builder }
  critic:  { label: The Critic }

initial_phase: implementing

phases:
  implementing:
    actor: builder
    half: top
    on: { owner_impl: reviewing, timeout: cancelled, cancel: cancelled }
  reviewing:
    actor: critic
    half: bottom
    on: { critic_lgtm: closing, critic_final: closing, critic_feedback: implementing, timeout: cancelled, cancel: cancelled }
  closing:
    actor: builder
    half: top
    on: { summary_posted: complete, timeout: complete, cancel: cancelled }
  complete:   { terminal: true }
  cancelled:  { terminal: true }

sentinels:
  implementing: "[builder→critic]"
  reviewing:    "[critic→builder]"
  closing:      "[summary]"

windows:
  implementing: 30m
  reviewing:    20m
  closing:      5m

disconnect_grace:
  builder: 2m
  critic:  30s

completion_event:
  protocol: build
  fields:
    - thread
    - rounds
    - roundsRun
    - outcome
    - task
    - cast
    - transcript
    - approved
```
