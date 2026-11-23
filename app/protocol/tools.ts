import { registry, addCapability, removeCapability, setToolDescription, removeToolDescriptions, setToolInputSchema, removeToolInputSchemas, type SessionInfo } from '../../sessions/registry.js'
import { killsInProgress } from '../session-lifecycle.js'
import type { ProtocolChildSpawnMetadata } from '../../sessions/protocol-registry.js'
import { pushToolSurface } from '../../sessions/tool-surface.js'
import { requiredLenses } from '../../protocols/modifiers.js'
import {
  formatAdvanceUsagePattern, isTerminal, MAX_EXTENSIONS_PER_PHASE,
  pendingPrivateProtocolChildren, privateProtocolChildren, runnerLifecycle, runs,
  sessionToRun, threadToRun, type ProtocolRun,
} from './state.js'

export function describePhaseTools(run: ProtocolRun, sessionId: string): { descriptions: { advance: string; extend_phase: string }; schemas: { advance: object } } | null {
  const role = run.sessionToRole.get(sessionId)
  if (!role) return null
  if (run.protocol.phases[run.phase]?.actor !== role) return null
  const ia = run.protocol.phaseInteraction(run.phase)
  if (!ia) return null
  const remaining = MAX_EXTENSIONS_PER_PHASE - run._extensions
  const descriptions = {
    advance: formatAdvanceUsagePattern(run.protocol, run.phase),
    extend_phase: remaining > 0
      ? `Request more time in the current protocol phase (${remaining} remaining). Resets the idle timeout.`
      : `All extensions used (${MAX_EXTENSIONS_PER_PHASE}/${MAX_EXTENSIONS_PER_PHASE}). No more extensions available this phase.`,
  }
  const schemas = {
    advance: buildAdvanceSchema(ia),
  }
  return { descriptions, schemas }
}

export function buildAdvanceSchema(ia: { verdict: 'none' | 'required' | 'optional'; options?: readonly string[] }): object {
  const contentProp = { type: 'string', description: 'Your deliverable — posted to the thread verbatim.' }
  const verdictDesc = ia.options?.length
    ? `Structured choice: ${ia.options.join(', ')}.`
    : 'Optional structured choice (pass when the protocol phase requires one).'
  const verdictProp = { type: 'string', description: verdictDesc }
  return {
    type: 'object',
    properties: { content: contentProp, verdict: verdictProp },
    required: ia.verdict === 'required' ? ['content', 'verdict'] : ['content'],
  }
}

export function clearProtocolOverrides(info: SessionInfo): void {
  removeCapability(info, 'protocol_context')
  removeCapability(info, 'protocol_spawn')
  removeToolDescriptions(info, 'advance', 'extend_phase')
  removeToolInputSchemas(info, 'advance')
}

export function setProtocolTools(run: ProtocolRun, sessionId: string): void {
  const info = registry.get(sessionId)
  if (!info) return

  clearProtocolOverrides(info)

  const overrides = describePhaseTools(run, sessionId)
  if (overrides) {
    addCapability(info, 'protocol_context')
    setToolDescription(info, 'advance', overrides.descriptions.advance)
    setToolDescription(info, 'extend_phase', overrides.descriptions.extend_phase)
    setToolInputSchema(info, 'advance', overrides.schemas.advance)
  }

  const role = run.sessionToRole.get(sessionId)
  const phase = run.protocol.phases[run.phase]
  if (role === phase?.actor) {
    for (const capability of phase.capabilities ?? []) addCapability(info, capability)
  }

  pushToolSurface(sessionId)
}

export function setRunTools(run: ProtocolRun): void {
  for (const [, sid] of run.participants) setProtocolTools(run, sid)
  registry.persist()
}

export function clearProtocolTools(run: ProtocolRun): void {
  for (const [, sid] of run.participants) {
    const info = registry.get(sid)
    if (!info) continue
    clearProtocolOverrides(info)
    pushToolSurface(sid)
  }
  registry.persist()
}

export function registerParticipant(run: ProtocolRun, role: string, sessionId: string): void {
  run.participants.set(role, sessionId)
  run.sessionToRole.set(sessionId, role)
  sessionToRun.set(sessionId, run.id)
  setProtocolTools(run, sessionId)
}

export function registerChild(run: ProtocolRun, parentSessionId: string, childSessionId: string, metadata: ProtocolChildSpawnMetadata): boolean {
  const role = run.sessionToRole.get(parentSessionId)
  const phase = run.protocol.phases[run.phase]
  if (role !== phase?.actor || !phase.capabilities?.includes('protocol_spawn')) return false
  ;(run.protocolChildren ??= new Map()).set(childSessionId, { phase: run.phase, parentSessionId, ...metadata })
  if (phase.privateChildren) privateProtocolChildren.add(childSessionId)
  return true
}

export function markPrivateChildLaunching(sessionId: string): void {
  pendingPrivateProtocolChildren.add(sessionId)
}

export function finishPrivateChildLaunch(sessionId: string): void {
  pendingPrivateProtocolChildren.delete(sessionId)
  if (!registry.has(sessionId)) privateProtocolChildren.delete(sessionId)
}

export function registerChildResult(run: ProtocolRun, childSessionId: string, targetSessionId: string, text: string): boolean {
  const child = run.protocolChildren.get(childSessionId)
  if (!child || child.phase !== run.phase || child.parentSessionId !== targetSessionId) return false
  child.result = text.trim()
  return true
}

export function releasePrivateChildWhenGone(sessionId: string): void {
  if (!registry.has(sessionId)) {
    privateProtocolChildren.delete(sessionId)
    return
  }
  // A concurrent/manual kill may already own this session. Keep the privacy
  // tombstone until registry removal proves the helper can no longer call us.
  const timer = setTimeout(() => releasePrivateChildWhenGone(sessionId), 250)
  timer.unref?.()
}

export function retireProtocolChildren(run: ProtocolRun, phase?: string): void {
  for (const [sessionId, child] of run.protocolChildren ?? []) {
    if (phase && child.phase !== phase) continue
    run.protocolChildren.delete(sessionId)
    const info = registry.get(sessionId)
    if (info && !killsInProgress.has(sessionId)) {
      void runnerLifecycle.killSession(info, 'protocol phase ended', { ended: 'killed by hydra' })
        .catch(err => process.stderr.write(`daemon: protocol child cleanup failed: ${err}\n`))
        .finally(() => releasePrivateChildWhenGone(sessionId))
    } else if (info) {
      releasePrivateChildWhenGone(sessionId)
    } else if (!pendingPrivateProtocolChildren.has(sessionId)) {
      privateProtocolChildren.delete(sessionId)
    }
  }
}


export function validateDelegatedBuildVerification(run: ProtocolRun, content: string): string | null {
  const reviewers = [...(run.protocolChildren?.values() ?? [])].filter(child =>
    child.phase === run.phase && child.readThread && !!child.phaseBudgetMs && !!child.result)
  if (reviewers.length === 0) {
    return 'step_passed requires a current-phase reviewer spawned with read_thread=true, and phase_budget that returned a result'
  }
  const verdicts = reviewers.map(reviewer => ({
    verdict: reviewer.result!.match(/(?:^|\n)[ \t]*verdict[ \t]*:[ \t]*(PASS WITH FIXES|PASS|FAIL)\b/i)?.[1]?.toUpperCase(),
    hasEvidence: /(?:^|\n)[ \t]*evidence[ \t]*:[ \t]*\S+/i.test(reviewer.result!),
  }))
  if (verdicts.some(({ verdict }) => verdict === 'FAIL')) {
    return 'step_passed is blocked because a current-phase reviewer returned `Verdict: FAIL`'
  }
  if (!verdicts.some(({ verdict, hasEvidence }) => verdict === 'PASS' && hasEvidence)) {
    return 'step_passed requires at least one reviewer result with `Verdict: PASS` and non-empty `Evidence:`'
  }
  const hasMechanicalChecks = /(?:^|\n)[ \t]*mechanical checks[ \t]*:[ \t]*\S+/i.test(content)
  const hasReviewer = /(?:^|\n)[ \t]*reviewer[ \t]*:[ \t]*\S+/i.test(content)
  const hasEvidence = /(?:^|\n)[ \t]*evidence[ \t]*:[ \t]*\S+/i.test(content)
  if (!hasMechanicalChecks || !hasReviewer || !hasEvidence) {
    return 'step_passed requires non-empty structured proof fields: `Mechanical checks:`, `Reviewer:`, and `Evidence:`'
  }
  return null
}

// Lens helpers are the reviewer's own native subagents, which Hydra can't observe,
// so the gate is on the output: `+<lens>` sections, and on approve the staged loop's close-out line.
// ponytail: trusts the reviewer not to write a section it didn't delegate; same trust as its own review.
function lensSection(name: string): RegExp {
  // A section line: optional markdown lead (#, >, *, _, `, bullets, "1.") then `+name` not followed by more lens-name chars.
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|\\n)[\\s#>*_\`-]*(\\d+\\.\\s*)?[*_\`]*\\+${esc}(?![a-z0-9-])`, 'i')
}

export function validateRequestedReviewLenses(run: ProtocolRun, content: string, verdict?: string): string | null {
  const required = requiredLenses(run.params)
  const lensHint = 'Run each required lens in its own native subagent and report it under a "+<lens>:" section (or "+<lens>: helper returned nothing")'
  // +subagent is a single pass: every lens in this one summary.
  if (run.phase === 'subagent_review') {
    const missing = required.filter(n => !lensSection(n).test(content))
    return missing.length ? `missing lens section${missing.length > 1 ? 's' : ''}: ${missing.map(n => `+${n}:`).join(', ')}. ${lensHint} before advancing` : null
  }
  // Critic: lenses run in their stage, so coverage accumulates across rounds and is checked at approve.
  const covered = new Set<string>((run.params.coveredLenses as string[] | undefined) ?? [])
  for (const n of required) if (lensSection(n).test(content)) covered.add(n)
  run.params.coveredLenses = [...covered]
  if (verdict !== 'approve') return null
  const missing = required.filter(n => !covered.has(n))
  if (missing.length) return `cannot approve: lens${missing.length > 1 ? 'es' : ''} never reported: ${missing.map(n => `+${n}:`).join(', ')}. ${lensHint}`
  const staged = run.params.autoReviewLenses === true && !run.params.noAutoLenses
  if (staged && !/Stage 3:\s*clean|No code changed since last clean pass/i.test(content)) {
    return 'cannot approve yet: the staged loop needs a fresh "Stage 3: clean" pass with no code change since (or "No code changed since last clean pass" after a debate-only round)'
  }
  return null
}



export function advancePhase(run: ProtocolRun, to: string, from: string): boolean {
  if (run.phase !== from) return false
  retireProtocolChildren(run, from)
  run.phase = to
  run._extensions = 0
  run._phaseStartedAt = Date.now()
  run._nudged = false
  run._escalated = false
  run._bridgeEscalated = false
  if (run._warningTimeout) { clearTimeout(run._warningTimeout); run._warningTimeout = undefined }
  if (run._totalTimeout) { clearTimeout(run._totalTimeout); run._totalTimeout = undefined }
  if (!isTerminal(run)) setRunTools(run)
  return true
}

// Rounds the run actually finished. The counter names the round in FLIGHT, so
// a run that stops mid-round has completed one fewer — and a direct start, which
// never enters a round at all, has completed none. Only a run that reached its
// closing phase has finished the round it is counting.


export function cleanupRun(run: ProtocolRun): void {
  retireProtocolChildren(run)
  run._pendingFallback = undefined
  for (const sid of run.sessionToRole.keys()) sessionToRun.delete(sid)
  threadToRun.delete(run.threadId)
  runs.delete(run.id)
}
