import type { CompletionEvent } from './protocol-types.js'

export type ReviewResult = 'approved' | 'approved_after_changes' | 'unresolved' | 'owner_run' | 'unknown'

/** Procedure completion is not approval. Classify the critic's final decision. */
export function reviewResult(event: CompletionEvent): ReviewResult {
  if (event.outcome !== 'complete') return 'unknown'
  if (event.terminalPhase === 'unresolved') return 'unresolved'
  const criticDecisions = event.decisions.filter(d => d.phase === 'critic_turn' && d.role === 'critic')
  const last = criticDecisions.at(-1)?.value
  if (event.via === 'fallback' || event.via === 'direct') {
    // A self-review cannot clear a live critic's outstanding change request.
    return last === 'request_changes' || last === 'approve_with_changes' ? 'unresolved' : 'owner_run'
  }
  if (event.via !== 'normal' || event.terminalPhase !== 'complete') return 'unknown'
  if (last !== 'approve') return 'unknown'
  return criticDecisions.some(d => d.value === 'approve_with_changes')
    ? 'approved_after_changes'
    : 'approved'
}

export function reviewResultLabel(result: ReviewResult): string {
  switch (result) {
    case 'approved': return 'approved'
    case 'approved_after_changes': return 'approved after changes and critic recheck'
    case 'unresolved': return 'changes unresolved'
    case 'owner_run': return 'owner-run review (no critic verdict)'
    case 'unknown': return 'no valid critic verdict'
  }
}
