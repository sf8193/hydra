# Delegate verified steps — handoff

## TL;DR

Design v2 is ready to implement. `delegate` becomes a stepwise build/verify/fresh-review/commit loop. `delegate!` preserves today's quick flow.

## Constraints and rejected ideas

See `design_v2.md`. Do not add a persistent reviewer role or claim opaque content proves a reviewed tree hash.

## Decisions log

- 2026-09-26: User chose PM as reviewer/orchestrator with a fresh spawned subagent to simplify the protocol.
- 2026-09-26: User asked to build it; ordinary delegate is rigorous and delegate! stays quick.

## Proposed verified steps

1. Extend DSL/tool scoping: verdict-specific final events, phase-scoped capabilities, protocol-child cleanup, and persistent deferred fallback until a fallback-capable phase or terminal. Exit: DSL/tool/lifecycle tests and compile checks pass.
2. Split quick protocol and implement rigorous delegate phases/prompts/fallback. Exit: quick and rigorous scenario tests pass.
3. Full verification and adversarial review. Exit: full suite and three builds pass; fresh reviewer reports no blocking findings.

## File index

- `design.md`: initial proposal.
- `design_v2.md`: corrected design.
- `discussion.md`: peer exchange.
- `HANDOFF.md`: implementation handoff.
