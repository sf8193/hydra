# Reviewer verdict protocol — peer discussion

## Glyph — 1

Proposed three critic verdicts. `approve` closes early; `request_changes` sends owner fixes back to critic until the cap; `approve_with_changes` asks the owner for bounded fixes and a report before closing. Asked for code-grounded critique of transitions, completion, and factory acceptance.

## Independent peer — 1

1. `decision.finalEvent` overrides the chosen verdict at the round cap (`daemon/protocol-runner.ts:1083-1088`). Do not use it for review, or add per-option final routing.
2. A terminal `unresolved` phase reached by `advance()` produces `outcome: complete` (`daemon/protocol-runner.ts:1023-1025`). Factory currently treats every complete review as acceptable (`daemon/factory.ts:1583-1605`). Carry a separate result and gate acceptance.
3. `cleanup` timeout completes without an owner post (`protocols/review.ts:23`). Conditional approval needs a dedicated owner phase whose timeout cancels.
4. The owner needs `applied` and `unable` outcomes when handling conditional changes. The last critic verdict alone cannot distinguish these results.
5. `CompletionEvent` should expose the terminal phase. A shared classifier should use `via`, terminal phase, and critic verdict, and both standalone review and factory must show the result.

Verdict on revised routing: sound with those changes. No code changes were made by the peer.

## Glyph — 2

Revised `reviewer-verdicts.md` to use the existing owner's final-round event for unresolved `request_changes`, an explicit `applied`/`unable` choice for conditional approval, a terminal phase in the completion event, and a shared result classifier. User decisions on conditional close and the round cap remain pending.

## User — 1

Chose critic recheck after conditional fixes. Chose additional review rounds after requests for changes, with a finite cap allowed.

## Independent peer — 2

Re-audited that decision. At the cap, a conditional verdict cannot be successful without a recheck. Recommended `apply_changes` return to the critic before the cap and end unresolved at the cap. Also identified all places where `rounds` drives prompts, badges, and completion metadata.

## Glyph — 3

Implemented the cap as a maximum of 20 critic turns, replacing the old default of 3. `review N` is an explicit lower hard cap. The user later specified a maximum of 20 rounds. The first code review found that terminal `unresolved` still emitted `outcome: complete` and passed the factory gate. Added terminal phase to completion events, a strict shared result classifier, and an acceptance gate. A second pass found that critic fallback after conditional fixes could bypass recheck; those results now remain unresolved.
