# Reviewer verdict protocol — draft

Status: implemented in `sf/reviewer-verdicts`. User chose critic recheck and more rounds; this implementation uses 10 as the default and maximum, with an explicit `review N` setting a lower cap.

## Goal

Give the Hydra critic three structured verdicts: `approve`, `request_changes`, and `approve_with_changes`. A completed review must expose the critic's verdict to its caller; an unresolved request must never look like approval. `rounds` remains a maximum review budget unless the user chooses another rule.

## Constraints and current behavior

| Case | Current behavior | Source |
| --- | --- | --- |
| Normal review | Critic posts prose, owner responds, and the exchange repeats until the configured round count. | `protocols/review.ts:20-23` |
| Final round | Owner's final response goes to cleanup regardless of whether the critic's last post found a blocker. | `protocols/review.ts:22` |
| Critic decision API | The DSL supports a required structured verdict and records it in `CompletionEvent.decisions`. | `daemon/protocol-dsl.ts:305-321`, `daemon/protocol-runner.ts:329-361` |
| Decision on final round | `finalEvent` overrides every verdict with one event. The build protocol uses this now. | `daemon/protocol-runner.ts:1079-1088`, `protocols/build.ts:25-36` |
| Normal completion | `CompletionEvent.outcome` is `complete`, with no top-level verdict; the factory treats all completed review runs as reviewed. | `daemon/protocol-runner.ts:1449-1463`, `daemon/factory.ts:1583-1605` |
| Critic death or silence | The review falls back to owner-run subagent review, or cancels with `+no-fallback`. | `protocols/review.ts:21,24-33`, `daemon/protocol-runner.ts:459-620` |
| Direct subagent review | `+subagent` skips the critic, so no independent critic verdict exists. | `daemon/protocol-runner.ts:171-205` |
| Timeout in cleanup | It completes even without an owner summary. | `protocols/review.ts:23`, `daemon/protocol-runner.ts:974-1006` |
| Factory PM handoff | Factory gets the owner's summary and offers accept, retry, or abandon. It does not surface a critic verdict. | `daemon/factory.ts:1583-1605,1828-1834` |

## Proposed transitions

| Critic verdict | Next actor and action | Closing status |
| --- | --- | --- |
| `approve` | Owner writes final summary. | Approved. Can close before max rounds. |
| `approve_with_changes` | Owner applies the critic's explicit, bounded changes, runs relevant checks, and reports each change. Owner can explicitly say the fixes could not be applied. | Critic rechecks before approval. The verdict itself never closes the review. |
| `request_changes` | Owner fixes or rebuts with evidence, then critic reviews again. | Continue until approval or the configured cap. The default cap rises from 3 to 20. At the cap, the owner responds, then review ends unresolved. |

`approve_with_changes` is for small, specific fixes whose acceptance criteria the critic can state up front. If the fix requires design judgment, a new behavior, or a broad rewrite, the critic must use `request_changes`. The reviewer sees the owner's fix report and rechecks it, then issues another verdict.

## State-machine sketch

```
critic_turn -- approve --> cleanup
critic_turn -- approve_with_changes --> apply_changes -- applied --> critic_turn
apply_changes -- final applied --> unresolved (no critic recheck remains)
apply_changes -- unable --> unresolved
critic_turn -- request_changes --> owner_turn --> critic_turn
critic_turn -- final request_changes --> owner_turn --> unresolved
critic_turn -- fallback --> subagent_review
```

`rounds` is the hard cap (default and maximum 20; explicit `review N` may lower it). A result on round 1 can end early. Compared with the old default of 3, the critic can request more work through round 20. At the cap, either non-approval path receives one owner response and ends unresolved. The review protocol does not need `decision.finalEvent`: approval exits immediately; the existing owner's `finalAdvanceEvent` can choose `unresolved` only when no further critic round is allowed. `unresolved` is a terminal phase representing a completed procedure with an unapproved result. The generic `CompletionEvent` should expose its terminal phase, alongside its existing `decisions`. One shared review-result classifier then checks, in order: terminal `unresolved`; `via: fallback/direct`; final critic decision. Missing or unknown decision yields `unknown`, never approval. Both standalone review and factory use this classifier. The factory surfaces the result and blocks ordinary acceptance of unresolved/unknown reviews, while preserving `reviewed=true` to mean the work was actually reviewed.

`apply_changes` goes back to `critic_turn` only after the owner posts an `applied` decision with a fix report and checks. An `unable` decision goes to `unresolved`. Its timeout goes to `cancelled`, so silence never turns a conditional approval into success. The current `cleanup` timeout behavior remains only for unconditional `approve`. The completion notification must name unresolved explicitly; default `notifyExit` currently says only "review complete."

The existing owner-run fallback has no independent critic verdict. Its result remains explicitly marked `via: fallback/direct`. If the critic had an outstanding `request_changes` or `approve_with_changes` verdict before fallback, classify the result as unresolved; self-review cannot clear those findings.

## Branch audit

| Branch | Proposed disposition |
| --- | --- |
| Critic approves before cap | Intentional change: closes early. |
| Critic approves on cap | Intentional change: closes approved. |
| Critic approves with changes | Intentional change: owner applies bounded fixes, reports checks, and critic rechecks; or owner explicitly reports unable and ends unresolved. |
| Owner cannot apply conditional fixes | Cancels/unresolved; never reports approved. |
| Critic requests changes before cap | Intentional change: owner fixes, then critic rechecks. |
| Critic requests changes after the old default of 3 rounds | Intentional change: review continues until the new cap of 20 or earlier approval. |
| Critic requests changes at hard cap | Intentional change: owner responds, then the completed procedure carries an unresolved verdict. Factory marks it reviewed but blocks ordinary acceptance and offers retry/abandon. |
| Critic timeout/death | Same fallback behavior and degraded label. |
| Owner timeout/death | Same cancellation behavior. |
| Direct subagent mode | Same independent-review caveat; no critic verdict. |
| Post-review PM action | PM still decides accept/retry/abandon; sees critic verdict and outstanding fixes. |

## Decisions

1. 2026-09-26: User chose critic recheck after `approve_with_changes`.
2. 2026-09-26: User chose additional rounds after change requests and allowed a finite cap. Implementation uses a default and maximum of 20; explicit `review N` sets a lower cap. The user later specified a maximum of 20 rounds.

## Implementation steps

1. Add verdict routing to the review protocol using the existing decision API and a 20-round default cap; prove all three paths at the initial and hard cap with the real protocol harness.
2. Expose terminal phase in `CompletionEvent`, derive the review result from terminal phase, `via`, and critic/owner decisions, then carry it through standalone and factory notifications. Gate acceptance of unresolved/unknown reviews; prove fallback labeling and that conditional approval requires an `applied` report.
3. Update prompts, summary format, command help, and diagrams; run Hydra's three compile checks and full Bun suite.

Out of scope: changing the build protocol's existing two-option decision, changing reviewer model selection, or changing the fallback architecture.
