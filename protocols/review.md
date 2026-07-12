# Adversarial Review — protocol

> A dyad protocol. A critic challenges a design; the owner defends across N rounds; the owner closes with one summary. Then the scaffolding is struck and the arc is preserved.
>
> This protocol is written as a document with two faces. The **prose** below is for a human — what it is, who speaks, what each turn owes. The **`skeleton` block** is for the daemon: it declares the phases, the sentinel grammar, the turn windows, and the completion event, and the daemon enforces them *by construction*. A role that forgets its tag is not silently dropped by convention — the document declares the tag the phase owes, and the daemon knows.

## Intent

Sharpen a design by putting it under sustained, structured attack. One critic, one owner, bounded rounds. The value is in the friction of the exchange; the summary is what survives it.

## Roles

| Role | Who | Owes |
|---|---|---|
| **critic** (The Critic) | a fresh-genesis spawn, principal-neutral by construction | opens with a critique, then counters each defense — one message per round, first line `[critic→owner]` |
| **owner** (The Owner) | the thread's own session — the one who built the thing | defends each round, first line `[owner→critic]`; after the debate, posts the summary, first line `[summary]` |

## Arc

1. **critic_turn** — the critic attacks. On a tagged post, the round advances to the owner.
2. **owner_turn** — the owner defends. Each defense returns the floor to the critic for the next round; the *final* defense ends the debate and enters post-pass (if lenses are configured) or cleanup.
3. **post_pass** — correctness is settled. If lenses were requested (`+readability`, `+security`, etc.), the critic runs each in sequence. Each pass is one turn; the critic posts `[critic→owner]` with feedback or LGTM. After all passes complete (or on timeout), the review enters cleanup.
4. **cleanup** — the debate is over; the owner writes one summary in the shape below. Posting it completes the review; a 5-minute silence auto-closes it.
5. **complete** / **cancelled** — terminal. Completion emits a structured event (see skeleton) and preserves the transcript before striking the round messages.

A turn that goes silent past its window cancels the review (except post_pass, which skips remaining passes and finishes gracefully). A participant whose bridge drops gets a grace period to reconnect before the review is abandoned.

## Lenses

Lenses are composable review passes applied after the correctness rounds. Each lens is a separate document in `protocols/lenses/` — a markdown file with instructions and a `yaml skeleton` block declaring its name and aliases.

Compose by writing: to add a new lens, write a new file. To request a lens at review time, use `+name` syntax: `review 3 +r +security`.

The daemon discovers lenses by scanning the lenses directory. A lens document's instructions are injected into the critic's prompt for that pass — the protocol knows the shape (one pass per lens, one turn per pass), the lens knows the content (what to look for).

## Summary shape

The owner's closing summary. One document, five movements — the same shape every protocol closes on.

- **🔬 Synthesis** — one sentence. The review in one breath.
- **Round Arc** — per round: `Critic … · Owner …`. What was pressed, what held.
- **📋 Dispositions** — `✅ fixed · ⚠️ deferred · ❌ rebutted`, one line each.
- **⚡ Tensions** — what was actually contested, not just flagged. Name the disagreement and who moved.
- **🌱 What Emerged** — what nobody asked for that showed up anyway. "Nothing" if the review was routine.
- **➡️ What's next** — what happens now and what needs the human.

## Skeleton

```yaml skeleton
protocol: review
emoji: "⚔️"
display_name: Adversarial Review

roles:
  critic: { label: The Critic }
  owner:  { label: The Owner }

initial_phase: critic_turn

phases:
  critic_turn:
    actor: critic
    half: top
    on: { critic_posted: owner_turn, timeout: cancelled, cancel: cancelled }
  owner_turn:
    actor: owner
    half: bottom
    on: { owner_posted: critic_turn, final_round: post_pass, timeout: cancelled, cancel: cancelled }
  post_pass:
    actor: critic
    half: bottom
    on: { pass_posted: post_pass, summary_posted: complete, timeout: cleanup, cancel: cancelled }
  cleanup:
    actor: owner
    half: top
    on: { summary_posted: complete, timeout: complete }
  complete:   { terminal: true }
  cancelled:  { terminal: true }

sentinels:
  critic_turn: "[critic→owner]"
  owner_turn:  "[owner→critic]"
  cleanup:     "[summary]"

windows:
  critic_turn: 10m
  owner_turn:  30m
  post_pass:   10m
  cleanup:     5m

disconnect_grace:
  critic: 30s
  owner:  2m

completion_event:
  protocol: review
  fields:
    - thread
    - rounds
    - roundsRun
    - outcome
    - topic
    - cast
    - transcript
    - struck
```
