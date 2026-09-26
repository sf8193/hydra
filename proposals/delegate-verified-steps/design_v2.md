# Delegate as verified steps — v2

## Accepted product decisions

- Ordinary `delegate` is rigorous; `delegate!` remains quick.
- PM orchestrates and commits; builder edits without committing.
- Each rigorous verification pass uses a fresh headless Hydra session spawned by the PM.
- The command integer remains a **total builder-turn budget**: both a fix pass and a new step consume one turn. It is not the plan's step count.
- The builder may read the full plan but is authorized to edit only the current step.

## Architecture

1. Split today's graph into `delegated-build-quick`; route `delegate!` there.
2. Replace `delegated-build` with:

```text
planning(PM) -> building(Builder) -> verifying(PM)
verifying -- request_changes --> building
verifying -- step_passed --> committing(PM)
committing -- next_step --> building
committing -- complete --> closing
```

3. Add verdict-specific cap routing to the DSL. At the final builder turn:
   - `request_changes` -> transient `cap_exhausted`
   - `step_passed` -> `committing`
   - `next_step` -> transient `cap_exhausted`
   - `complete` -> `closing`
4. Add phase-scoped capability `protocol_spawn` -> `spawn_session` and `kill_session`. Only the active PM in `verifying` receives it. The existing non-main kill authorization still restricts the PM to sessions it spawned. It is removed on every phase change and cleanup.
5. PM spawns a fresh headless reviewer with `read_thread=true` and a bounded `phase_budget`; the review prompt requires PASS/PASS WITH FIXES/FAIL and a result back to the PM via `send_to_thread`. Hydra registers protocol-spawned child IDs on the run and retires them on verification exit, cancellation, fallback, or completion; late results cannot advance the protocol. PM records reviewer name/verdict and mechanical checks in its advance content. This is auditable but content evidence is not cryptographically validated.
6. Builder fallback becomes PM self-build, then flows through the same verifying and committing phases. Degradation says delegation and independent authorship were lost; fresh review and commit sequencing remain. A deferred builder-death marker persists across PM-only phases and fires on the next fallback-capable building phase; it clears only on terminal completion.
7. `cap_exhausted` is a transient fail-closed phase whose entry behavior immediately transitions to the protocol's `cancelled` terminal with reason `builder-turn budget exhausted`. The completion event therefore has `outcome=cancelled`; existing consumers cannot confuse it with success.

## Enforcement

FSM-enforced: quick/rigorous separation, verify-before-commit sequencing, commit-before-next-step/complete, cap failure routing, scoped spawn capability.

Prompt/audit-enforced: exact file scope, no builder commit, mechanical command evidence, fresh reviewer identity, reviewed diff matching the commit. Structured evidence schemas/tree-hash verification are deferred.

## Audit against cases

- Normal multi-step: fixed; every step passes verify and commit phases.
- Review fixes: fixed; returns to builder and consumes budget.
- Clean pass at cap: preserved; can commit and complete.
- More work at cap: fixed; explicit cap exhaustion, never forced approval.
- Quick path: preserved in separate protocol.
- Builder death during building: PM self-build then verify/commit.
- Builder death while PM owns verify/commit: deferred marker persists; request/next enters fallback instead of waking a dead builder, while final completion clears it.
- Reviewer spawn unavailable: PM must not use `step_passed`; phase times out/cancels.
- Cleanup timeout: pre-existing behavior, out of scope.

## Required tests

- distinct command protocol selection for `delegate` and `delegate!`;
- quick end-to-end old graph;
- rigorous two-step phase trace;
- fix retry and next step both consume builder-turn budget;
- verdict-specific cap: fail closed vs clean pass;
- phase-scoped spawn/kill capability appears only in verifying and is removed on every exit path;
- PM self-build returns through verifying/committing;
- protocol-spawned reviewer children retire on result/phase exit/cancel/complete and late messages cannot advance;
- deferred builder death across verifying/committing and cap-exhausted completion metadata;
- prompts require step scope, mechanical proof, fresh reviewer, and PM commit.
