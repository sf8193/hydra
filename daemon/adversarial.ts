import { randomUUID } from 'crypto'
import { gateway } from './config.js'
import { registry } from './sessions.js'
import { doSpawnSession, killSession, killsInProgress } from './session-lifecycle.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TurnRole = 'critic' | 'advocate'

type Turn = {
  role: TurnRole
  round: number
}

export type ReviewState = {
  reviewId: string
  ownerThreadId: string
  ownerSessionId: string
  rounds: number
  turns: Turn[]
  currentTurnIndex: number
  currentMemberSessionId?: string
  status: 'active' | 'complete' | 'cancelled'
  timeout?: ReturnType<typeof setTimeout>
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const reviews = new Map<string, ReviewState>()
const memberToReview = new Map<string, string>()
const threadToReview = new Map<string, string>()

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export function getReviewByThread(threadId: string): ReviewState | undefined {
  const reviewId = threadToReview.get(threadId)
  return reviewId ? reviews.get(reviewId) : undefined
}

export function isReviewMember(sessionId: string): boolean {
  return memberToReview.has(sessionId)
}

// ---------------------------------------------------------------------------
// Start a review
// ---------------------------------------------------------------------------

export async function startReview(
  ownerThreadId: string,
  ownerSessionId: string,
  rounds: number,
): Promise<ReviewState> {
  const turns: Turn[] = []
  for (let r = 1; r <= rounds; r++) {
    turns.push({ role: 'critic', round: r })
    turns.push({ role: 'advocate', round: r })
  }

  const reviewId = randomUUID()
  const state: ReviewState = {
    reviewId,
    ownerThreadId,
    ownerSessionId,
    rounds,
    turns,
    currentTurnIndex: -1,
    status: 'active',
  }

  reviews.set(reviewId, state)
  threadToReview.set(ownerThreadId, reviewId)

  await gateway.send(ownerThreadId, [
    `**Adversarial Review** — ${rounds} round${rounds > 1 ? 's' : ''} starting`,
    `Critic and advocate will debate, then owner renders verdict.`,
  ].join('\n'))

  await advanceTurn(state)
  return state
}

// ---------------------------------------------------------------------------
// Cancel a review
// ---------------------------------------------------------------------------

export async function cancelReview(reviewId: string): Promise<void> {
  const state = reviews.get(reviewId)
  if (!state) return

  state.status = 'cancelled'
  if (state.timeout) clearTimeout(state.timeout)

  if (state.currentMemberSessionId) {
    const info = registry.get(state.currentMemberSessionId)
    if (info && !killsInProgress.has(state.currentMemberSessionId)) {
      await killSession(info, 'review cancelled')
    }
    memberToReview.delete(state.currentMemberSessionId)
  }

  threadToReview.delete(state.ownerThreadId)
  reviews.delete(reviewId)
  await gateway.send(state.ownerThreadId, `Review cancelled.`)
}

// ---------------------------------------------------------------------------
// Member lifecycle hooks
// ---------------------------------------------------------------------------

/** Called from bridge-server when a review member calls reply() successfully. */
export function onMemberPosted(sessionId: string): void {
  const reviewId = memberToReview.get(sessionId)
  if (!reviewId) return
  const state = reviews.get(reviewId)
  if (!state || state.status !== 'active') return
  if (state.currentMemberSessionId !== sessionId) return

  if (state.timeout) clearTimeout(state.timeout)

  // Brief delay for the message to land, then kill + advance
  setTimeout(async () => {
    const info = registry.get(sessionId)
    if (info && !killsInProgress.has(sessionId)) {
      await killSession(info, 'review turn complete')
    }
    memberToReview.delete(sessionId)
    state.currentMemberSessionId = undefined
    await advanceTurn(state)
  }, 3000)
}

/** Fallback: called when a member bridge disconnects unexpectedly. */
export function onMemberDisconnect(sessionId: string): void {
  const reviewId = memberToReview.get(sessionId)
  if (!reviewId) return
  const state = reviews.get(reviewId)
  if (!state || state.status !== 'active') return
  if (state.currentMemberSessionId !== sessionId) return

  if (state.timeout) clearTimeout(state.timeout)
  memberToReview.delete(sessionId)
  state.currentMemberSessionId = undefined

  process.stderr.write(`daemon: review member ${sessionId} disconnected, advancing\n`)
  void advanceTurn(state)
}

// ---------------------------------------------------------------------------
// Turn advancement
// ---------------------------------------------------------------------------

async function advanceTurn(state: ReviewState): Promise<void> {
  state.currentTurnIndex++

  if (state.currentTurnIndex >= state.turns.length) {
    state.status = 'complete'
    if (state.timeout) clearTimeout(state.timeout)
    threadToReview.delete(state.ownerThreadId)
    reviews.delete(state.reviewId)

    await gateway.send(state.ownerThreadId, [
      `**Review complete** — ${state.rounds} round${state.rounds > 1 ? 's' : ''} finished.`,
      `Owner: read the debate above and post your verdict.`,
    ].join('\n'))

    // Nudge the owner session
    const { transport } = await import('./bridge-transport.js')
    transport.sendOrQueue(state.ownerSessionId, {
      type: 'notification',
      content: `[system] Adversarial review complete in your thread. Use fetch_messages to read the full debate, then post your verdict and recommended changes.`,
      meta: {
        chat_id: state.ownerThreadId,
        message_id: '',
        user: 'system',
        user_id: 'system',
        ts: new Date().toISOString(),
      },
    })
    return
  }

  const turn = state.turns[state.currentTurnIndex]
  await spawnMember(state, turn)
}

// ---------------------------------------------------------------------------
// Member spawning
// ---------------------------------------------------------------------------

async function spawnMember(state: ReviewState, turn: Turn): Promise<void> {
  const { role, round } = turn
  const emoji = role === 'critic' ? '🔴' : '🟢'
  const label = `${emoji} **${role}** (round ${round}/${state.rounds})`

  await gateway.send(state.ownerThreadId, `${label} — spawning...`)

  const topic = `Adversarial ${role.toUpperCase()} round ${round}/${state.rounds}`

  try {
    const result = await doSpawnSession(topic, undefined, undefined, {
      joinThread: state.ownerThreadId,
      promptBuilder: (sessionId, tmuxName) =>
        buildMemberPrompt(sessionId, tmuxName, role, round, state.rounds, state.ownerThreadId),
    })

    state.currentMemberSessionId = result.sessionId
    memberToReview.set(result.sessionId, state.reviewId)

    // Safety timeout: 5 minutes per turn
    state.timeout = setTimeout(async () => {
      process.stderr.write(`daemon: review member ${result.sessionId} timed out\n`)
      const info = registry.get(result.sessionId)
      if (info && !killsInProgress.has(result.sessionId)) {
        await killSession(info, 'review turn timed out')
      }
      memberToReview.delete(result.sessionId)
      state.currentMemberSessionId = undefined
      await advanceTurn(state)
    }, 5 * 60 * 1000)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`daemon: review member spawn failed: ${msg}\n`)
    await gateway.send(state.ownerThreadId, `Failed to spawn ${role}: ${msg}. Advancing.`)
    await advanceTurn(state)
  }
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

function buildMemberPrompt(
  sessionId: string,
  tmuxName: string,
  role: TurnRole,
  round: number,
  totalRounds: number,
  threadId: string,
): string {
  const mandate = role === 'critic'
    ? `Find weaknesses, challenge assumptions, identify risks, and argue AGAINST the design. Be specific — cite code lines, data, or logical gaps. Concede strong points but push hard on weak ones.`
    : `Defend the design against critique. Address each criticism directly. Concede valid points, rebut weak ones, and propose mitigations where needed. Be specific — cite code, data, or reasoning.`

  return [
    `You are ${tmuxName}, an adversarial review ${role.toUpperCase()} (round ${round}/${totalRounds}).`,
    ``,
    `Your session_id is ${sessionId}.`,
    ``,
    `**Instructions:**`,
    `1. Call fetch_messages(channel="${threadId}", limit=100) to read the full conversation — the design discussion and any prior review rounds`,
    `2. Read any code files, wiki articles, or analysis referenced in the discussion to ground your argument`,
    `3. Post exactly ONE message with your ${role === 'critic' ? 'critique' : 'defense'} using reply(chat_id="${threadId}")`,
    `4. After posting, call set_description(session_id="${sessionId}", description="${role} r${round}/${totalRounds} — posted")`,
    ``,
    `**Your mandate:** ${mandate}`,
    ``,
    `Format with clear headers for each point. Be substantive and focused.`,
  ].join('\n')
}
