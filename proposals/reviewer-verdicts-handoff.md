# Hydra reviewer verdicts — handoff

## State

Implemented on `sf/reviewer-verdicts` in its isolated worktree. The protocol now asks the critic for `approve`, `request_changes`, or `approve_with_changes`. The owner applies conditional fixes and the critic rechecks them. Approval closes early; a non-approval on the configured last round ends unresolved after the owner's response. Default and maximum are 10 rounds; `review N` sets a lower cap.

## Decisions

| Date | Decision | Source |
| --- | --- | --- |
| 2026-09-26 | Conditional approval requires a critic recheck. | User |
| 2026-09-26 | Change requests may continue beyond the old default of three rounds, with a finite cap. | User |
| 2026-09-26 | Use twenty as the default and maximum. Explicit N is a hard cap. | User correction |

## Safety properties

- `approve_with_changes` never counts as approved until a subsequent critic `approve`.
- Owner `unable`, final-round `request_changes`, and final-round conditional fixes are unresolved.
- A fallback after an outstanding critic change request remains unresolved; owner-run review cannot clear the critic's finding.
- `CompletionEvent.outcome=complete` means the procedure ended. `terminalPhase` and the shared result classifier determine approval.
- Factory normal acceptance blocks unresolved or unknown results. An explicit `allow_unreviewed=true` override is logged and labeled.
- Retrying clears the previous review result, summary, and acceptance gate.

## Files

- `protocols/review.ts`: verdict transitions, conditional owner phase, prompts.
- `daemon/review-result.ts`: shared classifier and labels.
- `daemon/protocol-types.ts`, `daemon/protocol-runner.ts`: terminal phase in completion event.
- `daemon/factory.ts`: PM notification, acceptance gate, retry reset.
- `shared/constants.ts`, `shared/tool-definitions.ts`, command/template entrypoints: 20-round default and cap.
- `daemon/__tests__/protocol-scenarios.test.ts`, `daemon/__tests__/factory-qol.test.ts`, `daemon/__tests__/review-result.test.ts`: branch and integration cases.

## Checks

- `./compile-check.sh`: pass.
- `DISCORD_BOT_TOKEN=dummy bun test`: 1,847 pass, 0 fail.
- `git diff --check`: pass.
- Two independent code reviews returned PASS WITH FIXES. They found the unresolved acceptance bypass and a missing result in `factoryStatus`; both were fixed and rechecked.

## Next step

Commit through Graphite and report the branch. Deployment or daemon restart is separate from this code change.
