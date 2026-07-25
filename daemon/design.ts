import { gateway } from './config.js'
import { registry } from './sessions.js'
import { doSpawnSession, killSession, killsInProgress } from './session-lifecycle.js'
import { transport } from './bridge-transport.js'
import { registerProtocol, isThreadOccupied, dispatchProtocolComplete } from './protocol-registry.js'
import { clearQueue } from './command-queue.js'
import { createStateMachine } from './state-machine.js'
import { designPersonaPrompt, PERSONA_NAMES, normalizePersonaName, personaQuestionsTag, personaProposalTag, type PersonaName } from './prompts/design-personas.js'
import { designSynthesizerPrompt, SYNTHESIZER_TAG } from './prompts/design-synthesizer.js'
import { designAuditorPrompt, AUDITOR_TAG } from './prompts/design-auditor.js'
import { designBriefPrompt, BRIEF_TAG } from './prompts/design-brief.js'
import { refreshSessionVisual, registerProtocolBadge, formatPhaseBadge } from './anchor-state.js'
import { safeSend } from './util.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DesignPhase =
  | 'spawning'       // spawning persona sessions
  | 'questioning'    // personas posting clarifying questions
  | 'answering'      // waiting for user to answer aggregated questions
  | 'independent'    // waiting for all proposals
  | 'synthesis'      // synthesizer analyzing proposals
  | 'refinement'     // targeted persona refinement
  | 'audit'          // auditor reviewing composite
  | 'brief'          // generating final design brief
  | 'complete'
  | 'cancelled'

type DesignEvent =
  | 'all_spawned'
  | 'all_questions'
  | 'answers_provided'
  | 'all_proposed'
  | 'synthesized'
  | 'refined'
  | 'audited'
  | 'brief_posted'
  | 'timeout'
  | 'cancel'

export type DesignState = {
  ownerThreadId: string
  topic: string
  phase: DesignPhase
  personas: Array<{ name: string; sessionId: string; sessionName: string; asked: boolean; proposed: boolean }>
  synthesizerSessionId?: string
  auditorSessionId?: string
  briefSessionId?: string
  questionsExpected: number
  questionsReceived: number
  questions: Array<{ persona: string; questions: string }>
  proposalsExpected: number
  proposalsReceived: number
  divergences: Array<{ description: string; personas: string[]; impact: string }>
  currentDivergence: number
  refinementRound: number
  refinementQueue?: Array<{ description: string; personas: string[]; impact: string }>
  refinementExpected: number
  refinementResponses: number
  refinementRespondedIds: Set<string>
  timeout?: ReturnType<typeof setTimeout>
  _quorumNudgeTimer?: ReturnType<typeof setTimeout>
  _synthesizerDisconnectTimer?: ReturnType<typeof setTimeout>
  _auditorDisconnectTimer?: ReturnType<typeof setTimeout>
  _briefDisconnectTimer?: ReturnType<typeof setTimeout>
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

const designMachine = createStateMachine<DesignPhase, DesignEvent>('design', {
  spawning:    { all_spawned: 'questioning', timeout: 'cancelled', cancel: 'cancelled' },
  questioning: { all_questions: 'answering', timeout: 'answering', cancel: 'cancelled' },  // timeout advances (some personas may not have questions)
  answering:   { answers_provided: 'independent', timeout: 'cancelled', cancel: 'cancelled' },
  independent: { all_proposed: 'synthesis',  timeout: 'cancelled', cancel: 'cancelled' },
  synthesis:   { synthesized: 'refinement',  timeout: 'synthesis', cancel: 'cancelled' },  // timeout retries
  refinement:  { refined: 'synthesis',       timeout: 'cancelled', cancel: 'cancelled' },  // loops back for re-synthesis
  audit:       { audited: 'brief',           timeout: 'cancelled', cancel: 'cancelled' },
  brief:       { brief_posted: 'complete',   timeout: 'cancelled', cancel: 'cancelled' },
  complete:    {},
  cancelled:   {},
})

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const designs = new Map<string, DesignState>()  // keyed by threadId

const QUESTION_TIMEOUT_MS = 5 * 60 * 1000  // shorter than proposals
const PERSONA_TIMEOUT_MS = 15 * 60 * 1000
const SYNTHESIS_TIMEOUT_MS = 20 * 60 * 1000

export { PERSONA_NAMES, PersonaName }

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export function getDesignByThread(threadId: string): DesignState | undefined {
  return designs.get(threadId)
}

export function getActiveDesigns(): DesignState[] {
  return [...designs.values()].filter(d => d.phase !== 'complete' && d.phase !== 'cancelled')
}

registerProtocolBadge(threadId => {
  const state = getDesignByThread(threadId)
  return state ? formatPhaseBadge('🎨', state.phase) : undefined
})

export function isDesignParticipant(sessionId: string): boolean {
  for (const design of designs.values()) {
    if (design.personas.some(p => p.sessionId === sessionId)) return true
    if (design.synthesizerSessionId === sessionId) return true
    if (design.auditorSessionId === sessionId) return true
    if (design.briefSessionId === sessionId) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Start a design
// ---------------------------------------------------------------------------

export async function startDesign(
  threadId: string,
  topic: string,
): Promise<DesignState> {
  if (designs.has(threadId)) {
    throw new Error('A design session is already in progress in this thread')
  }
  const occupied = isThreadOccupied(threadId, 'design')
  if (occupied) {
    throw new Error(`A ${occupied} is in progress in this thread — finish or cancel it first`)
  }

  const state: DesignState = {
    ownerThreadId: threadId,
    topic,
    phase: 'spawning',
    personas: [],
    questionsExpected: PERSONA_NAMES.length,
    questionsReceived: 0,
    questions: [],
    proposalsExpected: PERSONA_NAMES.length,
    proposalsReceived: 0,
    divergences: [],
    currentDivergence: 0,
    refinementRound: 0,
    refinementExpected: 0,
    refinementResponses: 0,
    refinementRespondedIds: new Set(),
  }

  designs.set(threadId, state)
  refreshSessionVisual(threadId, { badge: '🎨' })

  await safeSend(threadId, [
    `**Design Session** — ${PERSONA_NAMES.length} personas`,
    `Topic: **${topic}**`,
    `Spawning ${PERSONA_NAMES.join(', ')}...`,
  ].join('\n'))

  // Record cutoff timestamp — personas should ignore messages after this point
  const cutoffTs = new Date().toISOString()

  // Spawn personas with 2s stagger
  // Intentionally omits model — personas always use SPAWN_MODEL (strongest available)
  for (const name of PERSONA_NAMES) {
    try {
      const result = await doSpawnSession(`Design persona: ${name}`, undefined, undefined, {
        trigger: 'design',
        joinThread: threadId,
        memberLabel: name,
        promptBuilder: (sessionId, tmuxName) => designPersonaPrompt({ sessionId, tmuxName, persona: name, topic, threadId, cutoffTs }),
      })
      state.personas.push({ name, sessionId: result.sessionId, sessionName: result.name, asked: false, proposed: false })
      process.stderr.write(`daemon: design: spawned ${name} as ${result.name}\n`)
      if (name !== PERSONA_NAMES[PERSONA_NAMES.length - 1]) {
        await new Promise(r => setTimeout(r, 2000))
      }
    } catch (err) {
      process.stderr.write(`daemon: design: failed to spawn ${name}: ${err}\n`)
    }
  }

  // Adjust expected count for failed spawns
  state.proposalsExpected = state.personas.length
  if (state.proposalsExpected === 0) {
    await safeSend(threadId, `No personas could be spawned. Design cancelled.`)
    designs.delete(threadId)
    refreshSessionVisual(threadId)
    clearQueue(threadId)
    state.phase = 'cancelled'
    return state
  }

  state.questionsExpected = state.personas.length

  const spawnResult = designMachine.transition(state.phase, 'all_spawned')
  if (spawnResult.ok) state.phase = spawnResult.to

  await safeSend(threadId, `_${state.personas.length} persona${state.personas.length > 1 ? 's' : ''} spawned: ${state.personas.map(p => `${p.name} → ${p.sessionName}`).join(' · ')}. Waiting for questions..._`)

  // Timeout for questions — advance even if some personas don't ask
  state.timeout = setTimeout(async () => {
    if (state.phase !== 'questioning') return
    process.stderr.write(`daemon: design: question timeout, advancing with ${state.questionsReceived} questions\n`)
    const r = designMachine.transition(state.phase, 'timeout')
    if (r.ok) state.phase = r.to
    await aggregateAndPostQuestions(state)
  }, QUESTION_TIMEOUT_MS)
  armQuorumNudge(state, 'questioning', QUESTION_TIMEOUT_MS)

  return state
}

// ---------------------------------------------------------------------------
// Quorum-silence nudge — at half-window, remind personas that haven't posted.
// Pure nudge: the timeout backstop above is untouched, and nothing advances
// here. Live evidence (2026-07-08 smoke run): one silent persona burned the
// entire question window, and its post landed 90s after the gavel — a
// half-window reminder converts that from a lost window into a caught one.
// ---------------------------------------------------------------------------

function armQuorumNudge(state: DesignState, phase: 'questioning' | 'independent', windowMs: number): void {
  if (state._quorumNudgeTimer) clearTimeout(state._quorumNudgeTimer)
  state._quorumNudgeTimer = setTimeout(() => {
    if (state.phase !== phase) return
    const silent = state.personas.filter(p => (phase === 'questioning' ? !p.asked : !p.proposed))
    if (silent.length === 0) return
    const what = phase === 'questioning' ? 'question' : 'proposal'
    process.stderr.write(`daemon: design: half-window nudge → ${silent.map(p => p.name).join(', ')} silent (${what} phase)\n`)
    for (const p of silent) {
      const tag = phase === 'questioning' ? personaQuestionsTag(p.name) : personaProposalTag(p.name)
      const noQuestionsHint = phase === 'questioning' ? ` (or that tag followed by "No questions.")` : ''
      transport.sendOrQueue(p.sessionId, {
        type: 'notification',
        content: [
          `[system] Half the ${what} window has passed and your post hasn't arrived.`,
          `Post now with first line \`${tag}\`${noQuestionsHint} — the phase advances without you otherwise.`,
        ].join('\n'),
        meta: { chat_id: state.ownerThreadId, message_id: '', user: 'system', user_id: 'system', ts: new Date().toISOString() },
      })
    }
  }, Math.floor(windowMs / 2))
}

// ---------------------------------------------------------------------------
// Question aggregation + answer handling
// ---------------------------------------------------------------------------

async function aggregateAndPostQuestions(state: DesignState): Promise<void> {
  if (state.timeout) clearTimeout(state.timeout)
  if (state._quorumNudgeTimer) clearTimeout(state._quorumNudgeTimer)

  if (state.questions.length === 0) {
    // No questions — skip straight to proposals
    await safeSend(state.ownerThreadId, `_No questions from personas. Proceeding to proposals..._`)
    const r = designMachine.transition(state.phase, 'answers_provided')
    if (r.ok) state.phase = r.to
    await startProposalPhase(state)
    return
  }

  const questionList = state.questions.map(q =>
    `**${q.persona}:**\n${q.questions}`
  ).join('\n\n')

  await safeSend(state.ownerThreadId, [
    `**Personas have questions before proposing:**`,
    ``,
    questionList,
    ``,
    `Answer in a single message. Your answers will be shared with all personas.`,
  ].join('\n'))

  // 30-min timeout for user to answer
  state.timeout = setTimeout(async () => {
    if (state.phase !== 'answering') return
    process.stderr.write(`daemon: design: answer timeout\n`)
    await safeSend(state.ownerThreadId, `Design timed out waiting for answers. Cancelling.`)
    await cancelDesign(state.ownerThreadId)
  }, 30 * 60 * 1000)
}

export async function handleDesignAnswer(threadId: string, answerText: string): Promise<void> {
  const state = designs.get(threadId)
  if (!state || state.phase !== 'answering') return

  const r = designMachine.transition(state.phase, 'answers_provided')
  if (!r.ok) return
  state.phase = r.to

  // Distribute answers to all personas
  for (const persona of state.personas) {
    transport.sendOrQueue(persona.sessionId, {
      type: 'notification',
      content: [
        `[system] The human answered your questions. Here are ALL answers for all personas:`,
        ``,
        answerText,
        ``,
        `Now post your proposal. Tag with \`${personaProposalTag(persona.name)}\`. Be INDEPENDENT — do not read other proposals.`,
      ].join('\n'),
      meta: { chat_id: state.ownerThreadId, message_id: '', user: 'system', user_id: 'system', ts: new Date().toISOString() },
    })
  }

  await startProposalPhase(state)
}

async function startProposalPhase(state: DesignState): Promise<void> {
  const aliveUnproposed = state.personas.filter(p => !p.proposed && transport.has(p.sessionId)).length
  if (aliveUnproposed === 0) {
    process.stderr.write(`daemon: design: no alive personas for proposals — cancelling\n`)
    await cancelDesign(state.ownerThreadId, `All personas crashed. Design cancelled.\nUse \`design: ${state.topic}\` to retry.`)
    return
  }

  await safeSend(state.ownerThreadId, `_${formatPhaseBadge('🎨', state.phase)} Waiting for proposals..._`)

  state.timeout = setTimeout(async () => {
    if (state.phase !== 'independent') return
    process.stderr.write(`daemon: design: proposal timeout\n`)
    await safeSend(state.ownerThreadId, `Design timed out waiting for proposals. Cancelling.`)
    await cancelDesign(state.ownerThreadId)
  }, PERSONA_TIMEOUT_MS)
  armQuorumNudge(state, 'independent', PERSONA_TIMEOUT_MS)
}

// ---------------------------------------------------------------------------
// Session cleanup — shared by cancel and completion paths
// ---------------------------------------------------------------------------

async function cleanupDesignSessions(state: DesignState, reason: string): Promise<void> {
  for (const p of state.personas) {
    const info = registry.get(p.sessionId)
    if (info && !killsInProgress.has(p.sessionId)) {
      await killSession(info, reason).catch(e => process.stderr.write(`daemon: design cleanup killSession failed: ${e}\n`))
    }
  }
  if (state.synthesizerSessionId) {
    const info = registry.get(state.synthesizerSessionId)
    if (info && !killsInProgress.has(state.synthesizerSessionId)) {
      await killSession(info, reason).catch(e => process.stderr.write(`daemon: design cleanup killSession failed: ${e}\n`))
    }
  }
  if (state.auditorSessionId) {
    const info = registry.get(state.auditorSessionId)
    if (info && !killsInProgress.has(state.auditorSessionId)) {
      await killSession(info, reason).catch(e => process.stderr.write(`daemon: design cleanup killSession failed: ${e}\n`))
    }
  }
  if (state.briefSessionId) {
    const info = registry.get(state.briefSessionId)
    if (info && !killsInProgress.has(state.briefSessionId)) {
      await killSession(info, reason).catch(e => process.stderr.write(`daemon: design cleanup killSession failed: ${e}\n`))
    }
  }
}

// ---------------------------------------------------------------------------
// Cancel a design
// ---------------------------------------------------------------------------

export async function cancelDesign(threadId: string, message?: string): Promise<void> {
  const state = designs.get(threadId)
  if (!state) return

  state.phase = 'cancelled'
  if (state.timeout) clearTimeout(state.timeout)
  if (state._quorumNudgeTimer) clearTimeout(state._quorumNudgeTimer)
  if (state._synthesizerDisconnectTimer) clearTimeout(state._synthesizerDisconnectTimer)
  if (state._auditorDisconnectTimer) clearTimeout(state._auditorDisconnectTimer)
  if (state._briefDisconnectTimer) clearTimeout(state._briefDisconnectTimer)

  await cleanupDesignSessions(state, 'design cancelled')
  designs.delete(threadId)
  refreshSessionVisual(threadId)
  clearQueue(threadId)
  await gateway.send(state.ownerThreadId, message ?? `Design session cancelled.`)
}

// ---------------------------------------------------------------------------
// Autonomous flow — auto-advance after each phase
// ---------------------------------------------------------------------------

const MAX_REFINEMENT_ROUNDS = 2

async function autoAdvanceAfterSynthesis(state: DesignState): Promise<void> {
  if (state.divergences.length === 0) {
    await safeSend(state.ownerThreadId, `_${formatPhaseBadge('🎨', 'audit')} No divergences found. Proceeding to audit._`)
    state.phase = 'audit'
    await spawnAuditor(state)
    return
  }

  state.refinementRound++

  // Round 1: high + medium. Round 2: only high.
  const toRefine = state.refinementRound === 1
    ? state.divergences.filter(d => d.impact === 'high' || d.impact === 'medium')
    : state.divergences.filter(d => d.impact === 'high')

  if (toRefine.length === 0 || state.refinementRound > MAX_REFINEMENT_ROUNDS) {
    await safeSend(state.ownerThreadId, `_${formatPhaseBadge('🎨', 'audit')} Refinement complete (${state.refinementRound - 1} round${state.refinementRound - 1 !== 1 ? 's' : ''}). Proceeding to audit._`)
    state.phase = 'audit'
    await spawnAuditor(state)
    return
  }

  await safeSend(state.ownerThreadId, `_Refinement round ${state.refinementRound}: ${toRefine.length} divergence${toRefine.length !== 1 ? 's' : ''} (${toRefine.map(d => d.impact).join(', ')})_`)

  const result = designMachine.transition(state.phase, 'synthesized')
  if (result.ok) state.phase = result.to
  state.currentDivergence = 0

  await runRefinement(state, toRefine)
}

async function autoAdvanceAfterRefinement(state: DesignState): Promise<void> {
  // Refinement done → re-synthesize (machine goes refinement → synthesis)
  const result = designMachine.transition(state.phase, 'refined')
  if (result.ok) state.phase = result.to

  await safeSend(state.ownerThreadId, `_Re-synthesizing with refinement feedback..._`)
  await spawnSynthesizer(state)
}

async function autoCompleteDesign(state: DesignState): Promise<void> {
  await safeSend(state.ownerThreadId, `_Audit complete. Generating design brief..._`)
  await spawnBriefWriter(state)
}

async function spawnBriefWriter(state: DesignState): Promise<void> {
  try {
    const result = await doSpawnSession(`Design brief writer`, undefined, undefined, {
        trigger: 'design',
      joinThread: state.ownerThreadId,
      memberLabel: 'brief',
      promptBuilder: (sessionId, tmuxName) => designBriefPrompt({
        sessionId,
        tmuxName,
        topic: state.topic,
        threadId: state.ownerThreadId,
        personaNames: state.personas.map(p => p.name),
      }),
    })

    state.briefSessionId = result.sessionId
    process.stderr.write(`daemon: design: brief writer spawned as ${result.name}\n`)

    state.timeout = setTimeout(async () => {
      if (state.phase !== 'brief') return
      process.stderr.write(`daemon: design: brief writer timeout\n`)
      await safeSend(state.ownerThreadId, `Brief writer timed out. Design complete without brief.`)
      if (state._synthesizerDisconnectTimer) clearTimeout(state._synthesizerDisconnectTimer)
      if (state._auditorDisconnectTimer) clearTimeout(state._auditorDisconnectTimer)
      if (state._briefDisconnectTimer) clearTimeout(state._briefDisconnectTimer)
      await cleanupDesignSessions(state, 'design complete')
      designs.delete(state.ownerThreadId)
      refreshSessionVisual(state.ownerThreadId)
      dispatchProtocolComplete(state.ownerThreadId)
    }, SYNTHESIS_TIMEOUT_MS)
  } catch (err) {
    process.stderr.write(`daemon: design: brief writer spawn failed: ${err}\n`)
    await safeSend(state.ownerThreadId, `Brief writer failed. Design complete without brief.`)
    if (state._synthesizerDisconnectTimer) clearTimeout(state._synthesizerDisconnectTimer)
    if (state._auditorDisconnectTimer) clearTimeout(state._auditorDisconnectTimer)
    if (state._briefDisconnectTimer) clearTimeout(state._briefDisconnectTimer)
    await cleanupDesignSessions(state, 'design complete')
    designs.delete(state.ownerThreadId)
    refreshSessionVisual(state.ownerThreadId)
    dispatchProtocolComplete(state.ownerThreadId)
  }
}

// ---------------------------------------------------------------------------
// Synthesizer
// ---------------------------------------------------------------------------

async function spawnSynthesizer(state: DesignState): Promise<void> {
  await safeSend(state.ownerThreadId, `_${formatPhaseBadge('🎨', state.phase)} Spawning synthesizer..._`)

  try {
    const result = await doSpawnSession(`Design synthesizer`, undefined, undefined, {
        trigger: 'design',
      joinThread: state.ownerThreadId,
      memberLabel: 'synthesizer',
      promptBuilder: (sessionId, tmuxName) => designSynthesizerPrompt({
        sessionId,
        tmuxName,
        topic: state.topic,
        threadId: state.ownerThreadId,
        personaNames: state.personas.map(p => p.name),
      }),
    })

    state.synthesizerSessionId = result.sessionId
    process.stderr.write(`daemon: design: synthesizer spawned as ${result.name}\n`)

    state.timeout = setTimeout(async () => {
      if (state.phase !== 'synthesis') return
      process.stderr.write(`daemon: design: synthesizer timeout, retrying\n`)
      // Kill the old synthesizer before respawning
      if (state.synthesizerSessionId) {
        const old = registry.get(state.synthesizerSessionId)
        if (old && !killsInProgress.has(state.synthesizerSessionId)) {
          await killSession(old, 'synthesizer timeout').catch(e => process.stderr.write(`daemon: design killSession failed: ${e}\n`))
        }
        state.synthesizerSessionId = undefined
      }
      await safeSend(state.ownerThreadId, `_Synthesizer timed out. Retrying..._`)
      await spawnSynthesizer(state)
    }, SYNTHESIS_TIMEOUT_MS)
  } catch (err) {
    process.stderr.write(`daemon: design: synthesizer spawn failed: ${err}\n`)
    await safeSend(state.ownerThreadId, `Synthesizer failed to spawn. Cancelling design.`)
    await cancelDesign(state.ownerThreadId)
  }
}

// ---------------------------------------------------------------------------
// Auditor
// ---------------------------------------------------------------------------

async function spawnAuditor(state: DesignState): Promise<void> {
  await safeSend(state.ownerThreadId, `_Spawning auditor for final review..._`)

  try {
    const result = await doSpawnSession(`Design auditor`, undefined, undefined, {
        trigger: 'design',
      joinThread: state.ownerThreadId,
      memberLabel: 'auditor',
      promptBuilder: (sessionId, tmuxName) => designAuditorPrompt({
        sessionId,
        tmuxName,
        topic: state.topic,
        threadId: state.ownerThreadId,
        personaNames: state.personas.map(p => p.name),
      }),
    })

    state.auditorSessionId = result.sessionId
    process.stderr.write(`daemon: design: auditor spawned as ${result.name}\n`)

    state.timeout = setTimeout(async () => {
      if (state.phase !== 'audit') return
      process.stderr.write(`daemon: design: auditor timeout\n`)
      const r = designMachine.transition(state.phase, 'timeout')
      if (r.ok) state.phase = r.to
      await safeSend(state.ownerThreadId, `Auditor timed out. Cancelling design.`)
      await cancelDesign(state.ownerThreadId)
    }, SYNTHESIS_TIMEOUT_MS)
  } catch (err) {
    process.stderr.write(`daemon: design: auditor spawn failed: ${err}\n`)
    // Fall back to complete without audit
    state.phase = 'complete'
    await safeSend(state.ownerThreadId, `Auditor failed to spawn. Design complete without audit.`)
    if (state._synthesizerDisconnectTimer) clearTimeout(state._synthesizerDisconnectTimer)
    if (state._auditorDisconnectTimer) clearTimeout(state._auditorDisconnectTimer)
    if (state._briefDisconnectTimer) clearTimeout(state._briefDisconnectTimer)
    designs.delete(state.ownerThreadId)
    refreshSessionVisual(state.ownerThreadId)
    dispatchProtocolComplete(state.ownerThreadId)
  }
}

// ---------------------------------------------------------------------------
// Parse divergences from synthesizer output
// ---------------------------------------------------------------------------

function parseDivergences(text: string): Array<{ description: string; personas: string[]; impact: string }> {
  const divergences: Array<{ description: string; personas: string[]; impact: string }> = []
  const block = text.match(/\[divergences\]\s*\n([\s\S]*?)(?:\n\n|\n```|$)/i)
  if (!block) {
    if (/divergen/i.test(text)) {
      process.stderr.write(`daemon: design: synthesizer mentioned divergences but [divergences] block not parsed — format mismatch\n`)
    }
    return divergences
  }

  const lines = block[1].split('\n').filter(l => l.trim())
  for (const line of lines) {
    // Split on | with lenient whitespace — supports multi-word impact
    const parts = line.replace(/^\d+\.\s*/, '').split('|').map(p => p.trim())
    if (parts.length >= 3) {
      divergences.push({
        description: parts[0],
        personas: parts[1].split(',').map(p => p.trim().replace(/\*\*/g, '')),  // strip bold markdown
        impact: parts[2].toLowerCase(),
      })
    }
  }
  return divergences
}

// ---------------------------------------------------------------------------
// Refinement
// ---------------------------------------------------------------------------

async function runRefinement(
  state: DesignState,
  selectedDivergences: Array<{ description: string; personas: string[]; impact: string }>,
): Promise<void> {
  state.refinementQueue = selectedDivergences
  state.refinementResponses = 0
  state.refinementExpected = 0

  await processNextDivergence(state)
}

async function processNextDivergence(state: DesignState): Promise<void> {
  const anyAlive = state.personas.some(p => transport.has(p.sessionId))
  if (!anyAlive) {
    process.stderr.write(`daemon: design: all personas dead at refinement entry — cancelling\n`)
    await cancelDesign(state.ownerThreadId, `All personas crashed during synthesis. Proposals were gathered but refinement couldn't run.\nUse \`design: ${state.topic}\` to retry.`)
    return
  }

  if (!state.refinementQueue || state.refinementQueue.length === 0) {
    void autoAdvanceAfterRefinement(state)
    return
  }

  const divergence = state.refinementQueue.shift()!
  state.currentDivergence++
  state.refinementResponses = 0
  state.refinementRespondedIds = new Set()

  // Find relevant personas — only those with a live transport connection
  const relevant = state.personas.filter(p =>
    transport.has(p.sessionId) && divergence.personas.some(name => normalizePersonaName(name) === normalizePersonaName(p.name))
  )
  state.refinementExpected = relevant.length

  if (relevant.length === 0) {
    await safeSend(state.ownerThreadId, `_Divergence ${state.currentDivergence}: no alive matching personas. Skipping._`)
    await processNextDivergence(state)
    return
  }

  await safeSend(state.ownerThreadId, [
    `_Refining divergence ${state.currentDivergence}: **${divergence.description}** (${divergence.impact})_`,
    `_Asking: ${relevant.map(p => p.name).join(', ')}_`,
  ].join('\n'))

  // Notify each relevant persona
  for (const persona of relevant) {
    transport.sendOrQueue(persona.sessionId, {
      type: 'notification',
      content: [
        `[system] Refinement requested on divergence: **${divergence.description}**`,
        ``,
        `Critique the synthesized composite design from your lens (${persona.name}).`,
        `Suggest specific modifications — don't argue with other personas, critique the proposal.`,
        ``,
        `Post your response with: \`${personaProposalTag(persona.name)}\``,
      ].join('\n'),
      meta: { chat_id: state.ownerThreadId, message_id: '', user: 'system', user_id: 'system', ts: new Date().toISOString() },
    })
  }

  // Timeout for refinement responses
  state.timeout = setTimeout(async () => {
    process.stderr.write(`daemon: design: refinement timeout\n`)
    await processNextDivergence(state)
  }, PERSONA_TIMEOUT_MS)
}

// ---------------------------------------------------------------------------
// Participant disconnect / reconnect — grace timer before cancelling
// ---------------------------------------------------------------------------

export function onDesignParticipantDisconnect(sessionId: string): void {
  for (const [threadId, state] of designs) {
    if (state.phase === 'complete' || state.phase === 'cancelled') continue

    // Identify which role disconnected
    const persona = state.personas.find(p => p.sessionId === sessionId)
    const isSynthesizer = state.synthesizerSessionId === sessionId
    const isAuditor = state.auditorSessionId === sessionId
    const isBrief = state.briefSessionId === sessionId

    if (!persona && !isSynthesizer && !isAuditor && !isBrief) continue
    if (transport.has(sessionId)) return

    const label = persona ? persona.name
      : isSynthesizer ? 'synthesizer'
      : isAuditor ? 'auditor'
      : 'brief writer'

    // Personas are expendable — adjust expectations immediately (no grace timer)
    if (persona) {
      const aliveCount = state.personas.filter(p => p.sessionId !== sessionId && transport.has(p.sessionId)).length
      process.stderr.write(`daemon: design: ${label} disconnected/died (${aliveCount} alive)\n`)
      void gateway.send(threadId, `_💀 ${label} (${persona.sessionName}) disconnected. ${aliveCount > 0 ? `Continuing with ${aliveCount} remaining persona${aliveCount !== 1 ? 's' : ''}.` : ''}_`).catch(err => process.stderr.write(`daemon: design: death notice send failed: ${err}\n`))

      const personaActivePhases: DesignPhase[] = ['questioning', 'independent', 'refinement']
      if (aliveCount === 0 && personaActivePhases.includes(state.phase)) {
        if (state.timeout) { clearTimeout(state.timeout); state.timeout = undefined }
        process.stderr.write(`daemon: design: all personas dead — cancelling\n`)
        void cancelDesign(threadId, `All personas crashed. Design cancelled.\nUse \`design: ${state.topic}\` to retry.`).catch(e => process.stderr.write(`daemon: design: cancel failed: ${e}\n`))
        return
      }

      if (state.phase === 'questioning') {
        state.questionsExpected--
        if (state.questionsExpected > 0 && state.questionsReceived >= state.questionsExpected) {
          if (state.timeout) clearTimeout(state.timeout)
          const result = designMachine.transition(state.phase, 'all_questions')
          if (result.ok) {
            state.phase = result.to
            void aggregateAndPostQuestions(state)
          }
        }
      } else if (state.phase === 'independent' && !persona.proposed) {
        state.proposalsExpected--
        if (state.proposalsExpected > 0 && state.proposalsReceived >= state.proposalsExpected) {
          if (state.timeout) clearTimeout(state.timeout)
          if (state._quorumNudgeTimer) clearTimeout(state._quorumNudgeTimer)
          const result = designMachine.transition(state.phase, 'all_proposed')
          if (result.ok) {
            state.phase = result.to
            void gateway.send(threadId, `_All ${state.proposalsReceived} proposals received. Auto-synthesizing..._`).catch(() => {})
            void spawnSynthesizer(state)
          }
        }
      } else if (state.phase === 'refinement') {
        state.refinementExpected--
        if (state.refinementExpected > 0 && state.refinementResponses >= state.refinementExpected) {
          if (state.timeout) clearTimeout(state.timeout)
          void processNextDivergence(state)
        }
      }
      return
    }

    // Singleton roles (synthesizer, auditor, brief) — per-role grace timer before cancel
    process.stderr.write(`daemon: design: ${label} disconnected — 30s grace period\n`)
    if (state.timeout) {
      clearTimeout(state.timeout)
      state.timeout = undefined
    }
    const timerField = isSynthesizer ? '_synthesizerDisconnectTimer' as const
      : isAuditor ? '_auditorDisconnectTimer' as const
      : '_briefDisconnectTimer' as const
    if (state[timerField]) clearTimeout(state[timerField])
    state[timerField] = setTimeout(async () => {
      process.stderr.write(`daemon: design: ${label} did not reconnect, cancelling design\n`)
      void cancelDesign(threadId).catch(e => process.stderr.write(`daemon: cancelDesign failed: ${e}\n`))
    }, 30_000)
    return
  }
}

/** Called when a bridge registers — clears disconnect grace period. */
export function onDesignParticipantReconnect(sessionId: string): void {
  for (const [, state] of designs) {
    if (state.phase === 'complete' || state.phase === 'cancelled') continue

    const timerField = state.synthesizerSessionId === sessionId ? '_synthesizerDisconnectTimer' as const
      : state.auditorSessionId === sessionId ? '_auditorDisconnectTimer' as const
      : state.briefSessionId === sessionId ? '_briefDisconnectTimer' as const
      : null

    if (!timerField || !state[timerField]) continue

    clearTimeout(state[timerField])
    state[timerField] = undefined
    process.stderr.write(`daemon: design participant ${sessionId} reconnected, grace period cleared\n`)
    return
  }
}

// ---------------------------------------------------------------------------
// Reply handler — track persona proposals + synthesizer output + refinement
// ---------------------------------------------------------------------------

export function onDesignReply(sessionId: string, text: string, chatId: string, sentMessageIds: string[]): void {
  // Find which design this session belongs to
  for (const [threadId, state] of designs) {
    if (chatId !== threadId) continue

    const persona = state.personas.find(p => p.sessionId === sessionId)

    // Persona posting questions
    if (persona && state.phase === 'questioning') {
      const firstLine = text.split('\n')[0].trim()
      const expectedTag = personaQuestionsTag(persona.name)
      if (!firstLine.startsWith(expectedTag)) return

      const bodyText = text.slice(text.indexOf('\n') + 1).trim()
      if (bodyText.toLowerCase() !== 'no questions.') {
        state.questions.push({ persona: persona.name, questions: bodyText })
      }
      persona.asked = true
      state.questionsReceived++
      process.stderr.write(`daemon: design: ${persona.name} asked questions (${state.questionsReceived}/${state.questionsExpected})\n`)

      if (state.questionsReceived >= state.questionsExpected) {
        const r = designMachine.transition(state.phase, 'all_questions')
        if (r.ok) state.phase = r.to
        void aggregateAndPostQuestions(state)
      }
      return
    }

    // Persona posting a proposal
    if (persona && state.phase === 'independent') {
      const firstLine = text.split('\n')[0].trim()
      const expectedTag = personaProposalTag(persona.name)
      if (!firstLine.startsWith(expectedTag)) return  // conversational, ignore

      if (persona.proposed) return  // already proposed, ignore duplicate
      persona.proposed = true
      state.proposalsReceived++
      process.stderr.write(`daemon: design: ${persona.name} proposed (${state.proposalsReceived}/${state.proposalsExpected})\n`)

      if (state.proposalsReceived >= state.proposalsExpected) {
        if (state.timeout) clearTimeout(state.timeout)
        if (state._quorumNudgeTimer) clearTimeout(state._quorumNudgeTimer)
        const result = designMachine.transition(state.phase, 'all_proposed')
        if (result.ok) {
          state.phase = result.to
          void gateway.send(threadId, `_All ${state.proposalsReceived} proposals received. Auto-synthesizing..._`).catch(() => {})
          void spawnSynthesizer(state)
        }
      }
      return
    }

    // Synthesizer posting
    if (state.synthesizerSessionId === sessionId && state.phase === 'synthesis') {
      const firstLine = text.split('\n')[0].trim()
      if (!firstLine.startsWith(SYNTHESIZER_TAG)) return

      if (state.timeout) clearTimeout(state.timeout)

      // Parse divergences from output
      state.divergences = parseDivergences(text)
      process.stderr.write(`daemon: design: synthesizer posted, ${state.divergences.length} divergences found\n`)

      const divList = state.divergences.length > 0
        ? state.divergences.map((d, i) => `  ${i + 1}. ${d.description} (${d.impact})`).join('\n')
        : '  (none identified)'
      void safeSend(threadId, [
        `_Synthesis complete. ${state.divergences.length} divergence${state.divergences.length !== 1 ? 's' : ''} found._`,
        ``,
        divList,
      ].join('\n'))

      // Auto-advance to refinement or audit
      void autoAdvanceAfterSynthesis(state)
      return
    }

    // Refinement responses from personas
    if (persona && state.phase === 'refinement') {
      const firstLine = text.split('\n')[0].trim()
      const expectedTag = personaProposalTag(persona.name)
      if (!firstLine.startsWith(expectedTag)) return

      // Dedup: skip if this persona already responded for current divergence
      if (state.refinementRespondedIds.has(persona.sessionId)) return
      state.refinementRespondedIds.add(persona.sessionId)
      state.refinementResponses++
      process.stderr.write(`daemon: design: ${persona.name} refined (${state.refinementResponses}/${state.refinementExpected})\n`)

      if (state.refinementResponses >= state.refinementExpected) {
        if (state.timeout) clearTimeout(state.timeout)
        void processNextDivergence(state)
      }
      return
    }

    // Brief writer posting
    if (state.briefSessionId === sessionId && state.phase === 'brief') {
      const firstLine = text.split('\n')[0].trim()
      if (!firstLine.startsWith(BRIEF_TAG)) return

      if (state.timeout) clearTimeout(state.timeout)
      if (state._synthesizerDisconnectTimer) clearTimeout(state._synthesizerDisconnectTimer)
      if (state._auditorDisconnectTimer) clearTimeout(state._auditorDisconnectTimer)
      if (state._briefDisconnectTimer) clearTimeout(state._briefDisconnectTimer)
      process.stderr.write(`daemon: design: brief posted\n`)

      const result = designMachine.transition(state.phase, 'brief_posted')
      if (result.ok) {
        state.phase = result.to
        void cleanupDesignSessions(state, 'design complete').catch(e => process.stderr.write(`daemon: design cleanup failed: ${e}\n`))
        designs.delete(threadId)
        refreshSessionVisual(threadId)
        void gateway.send(threadId, `_Design session complete._`).catch(() => {})
        dispatchProtocolComplete(threadId)
      }
      return
    }

    // Auditor posting
    if (state.auditorSessionId === sessionId && state.phase === 'audit') {
      const firstLine = text.split('\n')[0].trim()
      if (!firstLine.startsWith(AUDITOR_TAG)) return

      if (state.timeout) clearTimeout(state.timeout)
      process.stderr.write(`daemon: design: auditor posted findings\n`)

      const result = designMachine.transition(state.phase, 'audited')
      if (result.ok) {
        state.phase = result.to
        void autoCompleteDesign(state)
      }
      return
    }
  }
}


// ---------------------------------------------------------------------------
// Exports for state machine testing
// ---------------------------------------------------------------------------

export { designMachine }

registerProtocol('design', {
  getByThread: (threadId) => !!getDesignByThread(threadId),
  isParticipant: isDesignParticipant,
  onReply: onDesignReply,
  onDisconnect: onDesignParticipantDisconnect,
  onReconnect: onDesignParticipantReconnect,
  expectedTag: (sessionId, chatId) => {
    for (const state of designs.values()) {
      if (chatId !== state.ownerThreadId) continue
      const persona = state.personas.find(p => p.sessionId === sessionId)
      if (persona) {
        if (state.phase === 'questioning' && !persona.asked) {
          return personaQuestionsTag(persona.name)
        }
        if (state.phase === 'independent' && !persona.proposed) {
          return personaProposalTag(persona.name)
        }
        // refinement: only divergence-relevant personas owe a post, and that
        // relevance set is transient — nudging the full cast would misfire.
        return null
      }
      if (sessionId === state.synthesizerSessionId && state.phase === 'synthesis') return SYNTHESIZER_TAG
      if (sessionId === state.auditorSessionId && state.phase === 'audit') return AUDITOR_TAG
      if (sessionId === state.briefSessionId && state.phase === 'brief') return BRIEF_TAG
    }
    return null
  },
})
