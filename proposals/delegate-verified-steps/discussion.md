# Discussion

## Owner — 1

Proposed a PM-owned verified-step delegate with a fresh subagent per review and a separate quick path.

## Independent peer — 1

Verdict: REVISE. Found that quick mode shared the same FSM, cap routing was not verdict-specific, rounds conflated attempts and steps, PM lacked spawn capability, builder sees the full shared-thread plan, evidence was prompt-only, and fallback bypassed guarantees.

## Owner — 2

Revised in `design_v2.md`: separate quick protocol; total builder-turn budget; verdict-specific cap events; phase-scoped spawn capability; full plan visible but current-step authorization explicit; evidence claims labeled auditable rather than enforced; PM fallback returns through verify/commit.
