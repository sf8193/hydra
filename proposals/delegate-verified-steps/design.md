# Delegate as verified steps

## Constraints and decisions

- `delegate` becomes the rigorous path; `delegate!` remains the quick one-pass path.
- The PM owns the plan, mechanical verification, reviewer synthesis, and commits.
- The builder edits but does not commit.
- The PM uses a fresh native subagent for every review pass; no persistent third protocol participant.
- Existing builder-death fallback remains available.
- The plan is PM-approved on invocation; adding a separate human plan-approval command is out of scope.

## Current case matrix

| Case | Today | Source |
|---|---|---|
| Normal delegate | PM writes one spec; builder implements; PM approves or requests changes | `protocols/delegated-build.ts:19-24` |
| Requested changes | Same builder loops; round increments | `protocols/delegated-build.ts:21,45-49`; `protocol-runner.ts` round handling |
| Approval | Goes directly to closing; no mechanical or independent-review gate | `protocols/delegated-build.ts:21,45-49` |
| Final round | Any PM verdict is forced to approval by `finalEvent: pm_approve` | `protocols/delegated-build.ts:48` |
| Quick delegate | Skips clarification and starts building | `daemon/router.ts:672-683` |
| Builder dies | PM self-build fallback | `protocols/delegated-build.ts:20,91-98` |
| Cleanup timeout | Completes even without PM summary | `protocols/delegated-build.ts:23` (pre-existing, out of scope) |

## Proposed state machine

```text
planning(PM) → building(Builder)
building → verifying(PM)
verifying -- request_changes --> building
verifying -- step_passed --> committing(PM)
committing -- next_step --> building
committing -- complete --> closing
```

The PM's planning deliverable contains numbered atomic steps, allowed files, exclusions, and an executable exit criterion for each. The builder receives only the current step, must not commit, and reports changed files plus checks.

In `verifying`, the PM:

1. Runs the step's mechanical exit criterion itself.
2. Spawns a fresh native subagent with the step brief and diff.
3. Requires `PASS`, `PASS WITH FIXES`, or `FAIL` with evidence.
4. Uses `request_changes` unless the result is clean.
5. Uses `step_passed` only with mechanical and reviewer evidence in the content.

In `committing`, the PM commits exactly the reviewed step. It then chooses `next_step` with the next brief or `complete` with the final evidence roll-up.

`delegate!` retains the existing build → PM review → close flow and does not promise verified-step guarantees.

## Enforcement boundary

The FSM enforces that rigorous `delegate` cannot reach closing directly from review: it must pass through `committing`. The prompt and review evidence contract require a fresh subagent, but the daemon cannot prove a native engine subagent was actually spawned without a new engine-level attestation API. This version makes the artifact auditable rather than pretending that proof exists.

## Design × cases

| Case | Verdict |
|---|---|
| Normal delegate | changed intentionally: stepwise verified commits |
| Requested changes | fixed: loops before commit and requires re-review |
| Approval | fixed: independent-review evidence then commit gate |
| Final round | fixed: remove forced approval; cap exhaustion cancels/unresolved rather than silently passing |
| Quick delegate | same |
| Builder dies | same, but fallback disclosure says verification guarantee is lost |
| Cleanup timeout | out of scope |

## Rejected ideas

- PM reviews alone: lacks independence.
- Persistent reviewer role: complicates participant replacement and lifecycle for little benefit.
- Daemon performs git commits: crosses repository authority and worktree boundaries.
- Claim native subagent use is mechanically proven: current engines expose no attestation.

## Claim

This change makes ordinary delegation stepwise, mechanically checked, independently reviewed, and commit-gated. It does not provide durable restart recovery or cryptographic proof that the PM used a native subagent.
