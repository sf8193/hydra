import { execFileSync } from 'child_process'
import { createWorktree, destroyWorktree } from './worktree-manager.js'
import { gateway } from './config.js'
import { registry, sessionEmoji } from './sessions.js'
import { doSpawnSession, killSession, killsInProgress, waitForBridge } from './session-lifecycle.js'
import { transport } from './bridge-transport.js'
import { decideResume } from './auto-resume.js'
import { isAlive } from './util.js'
import { recordSessionDeath } from './observability.js'
import { registerProtocol, isThreadOccupied } from './protocol-registry.js'
import { buildOwnerPrompt } from './prompts/build-owner.js'
import { buildCriticPrompt } from './prompts/build-critic.js'
import { refreshSessionVisual, registerProtocolBadge, formatRoundBadge, formatStateLine } from './anchor-state.js'
import { getWatchesBySession } from './pr-watch.js'
import { buildSummaryFormat } from './prompts/build-summary.js'
import { createStateMachine } from './state-machine.js'
import { buildModel } from '../shared/constants.js'
import { safeSend, type StatusLineState } from './util.js'
import { dumpTranscript } from './transcript-dump.js'
import { withGuestToolScoping } from './bridge-tools.js'

export function taskToBranchName(task: string): string {
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 40)
    .replace(/-$/, '')
  return `sf/${slug || 'build'}`
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BuildPhase =
  | 'implementing'   // waiting for owner implementation summary
  | 'reviewing'      // waiting for critic review
  | 'closing'        // waiting for the builder's closing summary
  | 'complete'
  | 'cancelled'

export type BuildState = StatusLineState & {
  buildId: string
  ownerThreadId: string
  ownerSessionId: string
  criticSessionId?: string
  task: string
  rounds: number
  currentRound: number
  phase: BuildPhase
  timeout?: ReturnType<typeof setTimeout>
  _heartbeat?: ReturnType<typeof setInterval>
  _criticDisconnectTimer?: ReturnType<typeof setTimeout>
  _ownerDisconnectTimer?: ReturnType<typeof setTimeout>
  worktreeRepo?: string
  worktreePath?: string
  worktreeBranch?: string
  model?: string
  engine?: 'claude' | 'codex'
  _closing?: { approved: boolean; lastCriticText: string }  // set on closing entry, cleared at completion
  _resumeAttempts?: number
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const builds = new Map<string, BuildState>()
const sessionToBuild = new Map<string, string>()  // critic -> buildId
const ownerToBuild = new Map<string, string>()     // owner -> buildId
const threadToBuild = new Map<string, string>()    // thread -> buildId

export const CRITIC_TIMEOUT_MS = 20 * 60 * 1000
export const OWNER_TIMEOUT_MS = 30 * 60 * 1000

// ---------------------------------------------------------------------------
// Map cleanup — single function for all exit paths
// ---------------------------------------------------------------------------

function cleanupBuildMaps(state: BuildState): void {
  if (state.criticSessionId) sessionToBuild.delete(state.criticSessionId)
  ownerToBuild.delete(state.ownerSessionId)
  threadToBuild.delete(state.ownerThreadId)
  builds.delete(state.buildId)
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

type BuildEvent = 'owner_impl' | 'critic_lgtm' | 'critic_final' | 'critic_feedback' | 'summary_posted' | 'timeout' | 'cancel'

export const buildMachine = createStateMachine<BuildPhase, BuildEvent>('build', {
  implementing: { owner_impl: 'reviewing',    timeout: 'cancelled', cancel: 'cancelled' },
  reviewing:    { critic_lgtm: 'closing', critic_final: 'closing', critic_feedback: 'implementing', timeout: 'cancelled', cancel: 'cancelled' },
  closing:      { summary_posted: 'complete', timeout: 'complete', cancel: 'cancelled' },
  complete:     {},
  cancelled:    {},
})

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

function buildHalf(phase: BuildPhase): 'top' | 'bottom' {
  return phase === 'implementing' ? 'top' : 'bottom'
}

async function buildStatusLine(state: BuildState): Promise<void> {
  const half = buildHalf(state.phase)
  const isBuilderTurn = state.phase === 'implementing'
  const name = isBuilderTurn
    ? registry.get(state.ownerSessionId)?.tmuxName
    : (state.criticSessionId ? registry.get(state.criticSessionId)?.tmuxName : undefined)
  const action = isBuilderTurn
    ? (name ? `${sessionEmoji(name)} ${name} (The Builder) is building...` : 'builder is building...')
    : (name ? `${sessionEmoji(name)} ${name} (The Critic) is reviewing...` : 'critic is reviewing...')
  const text = formatStateLine('🔨', 'build', formatRoundBadge('', half, state.currentRound, state.rounds), action)
  if (!state.statusHistory) state.statusHistory = []
  state.statusHistory.push(text)
  const ids = await safeSend(state.ownerThreadId, text)
  state.messageIds.push(...ids)
}

registerProtocolBadge(threadId => {
  const state = getBuildByThread(threadId)
  if (!state) return undefined
  return formatRoundBadge('🔨', buildHalf(state.phase), state.currentRound, state.rounds)
})

export function getActiveBuilds(): BuildState[] {
  return [...builds.values()].filter(b => b.phase !== 'complete' && b.phase !== 'cancelled')
}

export function getBuildByThread(threadId: string): BuildState | undefined {
  const buildId = threadToBuild.get(threadId)
  return buildId ? builds.get(buildId) : undefined
}

export function isBuildParticipant(sessionId: string): boolean {
  return sessionToBuild.has(sessionId) || ownerToBuild.has(sessionId)
}

// ---------------------------------------------------------------------------
// Start a build
// ---------------------------------------------------------------------------

export async function startBuild(
  ownerThreadId: string,
  ownerSessionId: string,
  rounds: number,
  task?: string,
  worktreeTarget?: string,
  model?: string,
  engine?: 'claude' | 'codex',
): Promise<BuildState> {
  if (threadToBuild.has(ownerThreadId)) {
    throw new Error('A build is already in progress in this thread')
  }
  const occupied = isThreadOccupied(ownerThreadId, 'build')
  if (occupied) {
    throw new Error(`A ${occupied} is in progress in this thread — finish or cancel it first`)
  }

  const buildId = Math.random().toString(36).slice(2, 10)

  // Create worktree if requested
  let worktreeRepo: string | undefined
  let worktreePath: string | undefined
  let worktreeBranch: string | undefined
  if (worktreeTarget) {
    const spawnCwd = process.env.SPAWN_CWD
    if (!spawnCwd) throw new Error('SPAWN_CWD env var is required for worktree builds')

    const branch = taskToBranchName(task ?? 'build')
    const wt = await createWorktree({
      repoName: worktreeTarget,
      spawnCwd,
      branchName: branch,
      dirSuffix: `${worktreeTarget}-build-${buildId}`,
    })

    worktreeRepo = wt.repoDir
    worktreePath = wt.worktreePath
    worktreeBranch = wt.branch
  }

  const state: BuildState = {
    buildId,
    ownerThreadId,
    ownerSessionId,
    task: task ?? 'implement the design discussed above',
    rounds,
    currentRound: 1,
    phase: 'implementing',
    messageIds: [],
    worktreeRepo,
    worktreePath,
    worktreeBranch,
    model,
    ...(engine ? { engine } : {}),
  }

  builds.set(buildId, state)
  threadToBuild.set(ownerThreadId, buildId)
  ownerToBuild.set(ownerSessionId, buildId)
  refreshSessionVisual(ownerThreadId, { badge: formatRoundBadge('🔨', buildHalf(state.phase), state.currentRound, state.rounds) })

  try {
    const taskLine = task ? `\nTask: **${task}**` : ''
    const wtLine = worktreePath ? `\nWorktree: \`${worktreePath}\`` : ''
    const annIds = await safeSend(ownerThreadId, [
      `**Build** — ${rounds} round${rounds > 1 ? 's' : ''}`,
      `Owner implements, critic reviews.${taskLine}${wtLine}`,
    ].join('\n'))
    state.messageIds.push(...annIds)

    // Tell owner to start implementing
    transport.sendOrQueue(ownerSessionId, {
      type: 'notification',
      content: buildOwnerPrompt({ rounds, task, buildId, worktreePath }),
      meta: { chat_id: ownerThreadId, message_id: '', user: 'system', user_id: 'system', ts: new Date().toISOString() },
    })

    buildStatusLine(state)

    // Critic spawns later — after owner posts implementation summary
    resetTimeout(state)
    return state
  } catch (err) {
    cleanupBuildMaps(state)
    throw err
  }
}

// ---------------------------------------------------------------------------
// Cancel a build
// ---------------------------------------------------------------------------

export async function cancelBuild(buildId: string): Promise<void> {
  const state = builds.get(buildId)
  if (!state) return

  const transition = buildMachine.transition(state.phase, 'cancel')
  if (!transition.ok) return
  state.phase = transition.to
  if (state.timeout) clearTimeout(state.timeout)
  if (state._heartbeat) clearInterval(state._heartbeat)
  if (state._criticDisconnectTimer) clearTimeout(state._criticDisconnectTimer)
  if (state._ownerDisconnectTimer) clearTimeout(state._ownerDisconnectTimer)

  try {
    if (state.criticSessionId) {
      const info = registry.get(state.criticSessionId)
      if (info && !killsInProgress.has(state.criticSessionId)) {
        await killSession(info, 'build cancelled')
      }
    }
  } catch (err) {
    process.stderr.write(`daemon: build cancel killSession failed: ${err}\n`)
  } finally {
    cleanupBuildMaps(state)
  }

  refreshSessionVisual(state.ownerThreadId)
  await safeSend(state.ownerThreadId, `Build cancelled.`)

  cleanupWorktree(state)
}

// ---------------------------------------------------------------------------
// Core reply handler — called from bridge-server for ALL reply tool calls
// ---------------------------------------------------------------------------

export const BUILDER_SENTINEL = '[builder→critic]'
export const CRITIC_SENTINEL = '[critic→builder]'
export const SUMMARY_SENTINEL = '[summary]'

export function onBuildReply(sessionId: string, text: string, chatId: string, sentMessageIds: string[]): void {
  const firstLine = text.split('\n')[0].trim()

  // Check if this is the critic posting
  const memberBuildId = sessionToBuild.get(sessionId)
  if (memberBuildId) {
    const state = builds.get(memberBuildId)
    if (!state || chatId !== state.ownerThreadId || state.criticSessionId !== sessionId) return

    // Only process messages with the critic sentinel
    if (!firstLine.startsWith(CRITIC_SENTINEL)) return

    const bodyText = text.slice(text.indexOf('\n') + 1).trim()
    const secondLine = bodyText.split('\n')[0].trim()
    const isLgtm = secondLine === '**LGTM**' || secondLine === 'LGTM'
    const isFinal = !isLgtm && state.currentRound >= state.rounds
    const event: BuildEvent = isLgtm ? 'critic_lgtm' : isFinal ? 'critic_final' : 'critic_feedback'
    const result = buildMachine.transition(state.phase, event)
    if (!result.ok) return

    state.messageIds.push(...sentMessageIds)
    if (isLgtm || isFinal) {
      state.phase = result.to
      // Set before the async requestBuildSummary — its killSession await
      // creates a window where the owner can post [summary] and read _closing.
      state._closing = { approved: isLgtm, lastCriticText: bodyText }
      void requestBuildSummary(state, bodyText, isLgtm).catch(err => {
        process.stderr.write(`daemon: requestBuildSummary failed: ${err}\n`)
        void cancelBuild(state.buildId).catch(e => process.stderr.write(`daemon: cancelBuild failed: ${e}\n`))
      })
    } else {
      state.phase = result.to
      state.currentRound++
      onCriticFeedback(state, bodyText)
    }
    return
  }

  // Check if this is the owner posting during a build
  const ownerBuildId = ownerToBuild.get(sessionId)
  if (ownerBuildId) {
    const state = builds.get(ownerBuildId)
    if (!state || chatId !== state.ownerThreadId) return

    // Closing phase: the builder posts the closing summary
    if (state.phase === 'closing') {
      if (!firstLine.startsWith(SUMMARY_SENTINEL)) return
      if (state.timeout) clearTimeout(state.timeout)
      const r = buildMachine.transition(state.phase, 'summary_posted')
      if (!r.ok) return
      state.phase = r.to
      state.messageIds.push(...sentMessageIds)
      const ctx = state._closing
      state._closing = undefined
      completeBuild(state, ctx?.approved ?? true, ctx?.lastCriticText ?? '')
      return
    }

    // Only process messages with the builder sentinel
    if (!firstLine.startsWith(BUILDER_SENTINEL)) return

    const bodyText = text.slice(text.indexOf('\n') + 1).trim()
    const result = buildMachine.transition(state.phase, 'owner_impl')
    if (!result.ok) return

    state.messageIds.push(...sentMessageIds)
    state.phase = result.to
    onOwnerPosted(state, bodyText)
  }
}

/** Called when a build participant bridge disconnects. Grace period before cancel. */
export function onBuildParticipantDisconnect(sessionId: string): void {
  const buildId = sessionToBuild.get(sessionId) ?? ownerToBuild.get(sessionId)
  if (!buildId) return
  const state = builds.get(buildId)
  if (!state || state.phase === 'complete' || state.phase === 'cancelled') return
  // Closing: the critic is already dead by design, and if the builder dies the
  // 5-minute summary backstop completes the build — a disconnect-cancel here
  // would kill a build that is finishing.
  if (state.phase === 'closing') return
  if (transport.has(sessionId)) return

  if (state.criticSessionId === sessionId) {
    const info = registry.get(sessionId)
    const claudeSessionId = info?.claudeSessionId
    state._criticDisconnectTimer = setTimeout(async () => {
      if (state.phase === 'cancelled' || state.phase === 'complete') return
      const currentInfo = registry.get(sessionId)
      const decision = decideResume(
        transport.has(sessionId),
        currentInfo ? !isAlive(currentInfo) : true,
        !!claudeSessionId,
        state._resumeAttempts ?? 0,
      )
      if (decision === 'reconnected') return
      if (decision === 'resume' && claudeSessionId) {
        state._resumeAttempts = (state._resumeAttempts ?? 0) + 1
        if (currentInfo) recordSessionDeath(currentInfo, 'critic exited (auto-resuming)')
        try {
          const result = await doSpawnSession(currentInfo?.topic ?? `Build critic (${state.rounds} rounds)`, undefined, undefined, withGuestToolScoping({
            joinThread: state.ownerThreadId, resumeFrom: claudeSessionId, model: state.model,
            disallowedTools: [...PROTOCOL_GUEST_DISALLOWED_BUILTINS],
          }))
          // Pre-queue notification so it flushes on bridge connect — prevents
          // Claude Code from exiting before receiving new input.
          transport.sendOrQueue(result.sessionId, {
            type: 'notification',
            content: `[system] Your session was resumed. Check your thread for any messages you may have missed, and continue where you left off.`,
            meta: { chat_id: state.ownerThreadId, message_id: '', user: 'system', user_id: 'system', ts: new Date().toISOString() },
          })
          const ok = await waitForBridge(result.sessionId, 30_000)
          if (!ok) {
            const ni = registry.get(result.sessionId)
            if (ni) await killSession(ni, 'auto-resume health check failed').catch(() => {})
            throw new Error('resumed session did not connect')
          }
          if (currentInfo) currentInfo.deadAt = Date.now()
          sessionToBuild.delete(sessionId)
          state.criticSessionId = result.sessionId
          sessionToBuild.set(result.sessionId, state.buildId)
          resetTimeout(state)
          process.stderr.write(`daemon: build critic auto-resumed: ${sessionId} → ${result.sessionId}\n`)
        } catch (err) {
          process.stderr.write(`daemon: build critic auto-resume failed: ${err}\n`)
          void cancelBuild(state.buildId).catch(e => process.stderr.write(`daemon: cancelBuild failed: ${e}\n`))
        }
      } else {
        state._criticDisconnectTimer = setTimeout(() => {
          void cancelBuild(state.buildId).catch(e => process.stderr.write(`daemon: cancelBuild failed: ${e}\n`))
        }, 30_000)
      }
    }, 3_000)
  } else if (state.ownerSessionId === sessionId) {
    process.stderr.write(`daemon: build owner disconnected — 2min grace period\n`)
    if (state.timeout) {
      clearTimeout(state.timeout)
      state.timeout = undefined
    }
    if (state.criticSessionId) {
      transport.sendOrQueue(state.criticSessionId, {
        type: 'notification',
        content: `[system] Owner session disconnected. Waiting up to 2 minutes for reconnect before cancelling.`,
        meta: { chat_id: state.ownerThreadId, message_id: '', user: 'system', user_id: 'system', ts: new Date().toISOString() },
      })
    }
    state._ownerDisconnectTimer = setTimeout(async () => {
      process.stderr.write(`daemon: build owner did not reconnect, cancelling build\n`)
      void cancelBuild(state.buildId).catch(e => process.stderr.write(`daemon: cancelBuild failed: ${e}\n`))
    }, 120_000)
  }
}

/** Called when a bridge registers — clears disconnect grace period. */
export function onBuildParticipantReconnect(sessionId: string): void {
  const buildId = sessionToBuild.get(sessionId) ?? ownerToBuild.get(sessionId)
  if (!buildId) return
  const state = builds.get(buildId)
  if (!state) return
  if (state.criticSessionId === sessionId && state._criticDisconnectTimer) {
    clearTimeout(state._criticDisconnectTimer)
    state._criticDisconnectTimer = undefined
  } else if (state.ownerSessionId === sessionId && state._ownerDisconnectTimer) {
    clearTimeout(state._ownerDisconnectTimer)
    state._ownerDisconnectTimer = undefined
  } else {
    return
  }
  resetTimeout(state)
  process.stderr.write(`daemon: build participant ${sessionId} reconnected, grace period cleared\n`)
}

// ---------------------------------------------------------------------------
// Turn handlers
// ---------------------------------------------------------------------------

function onOwnerPosted(state: BuildState, text: string): void {
  if (state.timeout) clearTimeout(state.timeout)
  const roundLabel = `Round ${state.currentRound}/${state.rounds}`
  buildStatusLine(state)

  // Phase already set to 'reviewing' by the dispatcher
  if (!state.criticSessionId) {
    // First round — spawn critic with the implementation text as context
    void spawnCritic(state, text).catch(err => {
      process.stderr.write(`daemon: build: critic spawn failed in onOwnerPosted: ${err}\n`)
      void cancelBuild(state.buildId).catch(e => process.stderr.write(`daemon: cancelBuild failed: ${e}\n`))
    })
  } else {
    // Subsequent rounds — relay to existing critic
    transport.sendOrQueue(state.criticSessionId, {
      type: 'notification',
      content: `[Build — Owner Implementation ${roundLabel}]\n\n${text}\n\n---\nReview this implementation. Follow your initial instructions.`,
      meta: { chat_id: state.ownerThreadId, message_id: '', user: 'build-owner', user_id: 'system', ts: new Date().toISOString() },
    })
    resetTimeout(state)
  }
}

function onCriticFeedback(state: BuildState, text: string): void {
  if (state.timeout) clearTimeout(state.timeout)
  const roundLabel = `Round ${state.currentRound}/${state.rounds}`

  buildStatusLine(state)

  transport.sendOrQueue(state.ownerSessionId, {
    type: 'notification',
    content: `⚠️ **CRITIC FEEDBACK — action required**\n\n${text}\n\n---\nFix these issues, commit, and post your updated summary for ${roundLabel}.`,
    meta: { chat_id: state.ownerThreadId, message_id: '', user: 'build-critic', user_id: 'system', ts: new Date().toISOString() },
  })

  resetTimeout(state)
}

// ---------------------------------------------------------------------------
// Phase transitions
// ---------------------------------------------------------------------------

async function requestBuildSummary(state: BuildState, lastCriticText: string, approved: boolean): Promise<void> {
  // Kill critic
  if (state.criticSessionId) {
    sessionToBuild.delete(state.criticSessionId)
    try {
      const criticInfo = registry.get(state.criticSessionId)
      if (criticInfo && !killsInProgress.has(state.criticSessionId)) {
        await killSession(criticInfo, 'build complete')
      }
    } catch (err) {
      process.stderr.write(`daemon: build requestBuildSummary killSession failed: ${err}\n`)
    }
    state.criticSessionId = undefined
  }

  // Closing transition: new message (linear, not edited onto the status line)
  void safeSend(state.ownerThreadId, formatStateLine('🔨', 'build', '⚒︎', 'has concluded. Processing summary…'))

  // The critic heartbeat is moot once the critic is gone — stop the no-op
  // ticks. Pending disconnect timers from the reviewing phase must die too,
  // or a stale one fires mid-closing and cancels a completing build.
  if (state._heartbeat) clearInterval(state._heartbeat)
  if (state._criticDisconnectTimer) clearTimeout(state._criticDisconnectTimer)
  if (state._ownerDisconnectTimer) clearTimeout(state._ownerDisconnectTimer)

  // Backstop: complete without a summary rather than hold the thread hostage.
  if (state.timeout) clearTimeout(state.timeout)
  state.timeout = setTimeout(() => {
    if (state.phase !== 'closing') return
    const r = buildMachine.transition(state.phase, 'timeout')
    if (r.ok) state.phase = r.to
    state._closing = undefined
    completeBuild(state, approved, lastCriticText)
  }, 5 * 60 * 1000)

  const prLinks = getWatchesBySession(state.ownerSessionId).map(w => w.prUrl)
  transport.sendOrQueue(state.ownerSessionId, {
    type: 'notification',
    content: [
      `[system] Build ${approved ? 'approved (**LGTM**)' : 'reached max rounds'} after ${state.currentRound} round${state.currentRound > 1 ? 's' : ''}.`,
      `Post a closing summary to your thread.`,
      ``,
      `**Message routing:** Your first line MUST be \`${SUMMARY_SENTINEL}\`. Messages without this tag won't complete the build.`,
      ``,
      `Use this format:`,
      `${SUMMARY_SENTINEL}`,
      ...buildSummaryFormat(state.currentRound, prLinks),
    ].join('\n'),
    meta: { chat_id: state.ownerThreadId, message_id: '', user: 'system', user_id: 'system', ts: new Date().toISOString() },
  })
}

async function completeBuild(state: BuildState, approved: boolean, lastCriticText: string): Promise<void> {
  process.stderr.write(`daemon: build: complete (approved=${approved}, rounds=${state.currentRound}/${state.rounds})\n`)
  const status = approved
    ? `Critic approved (**LGTM**) after ${state.currentRound} round${state.currentRound > 1 ? 's' : ''}.`
    : `Max rounds reached (${state.rounds}). Critic had remaining concerns.`

  const continueHint = approved ? '' : `\nTo continue with more rounds, type \`build 2\` (or however many rounds you want).`
  const lastFeedback = approved ? '' : `\n\n**Last critic feedback:**\n${lastCriticText.slice(0, 1500)}`

  transport.sendOrQueue(state.ownerSessionId, {
    type: 'notification',
    content: `[system] Build complete. ${status}${continueHint}${lastFeedback}`,
    meta: { chat_id: state.ownerThreadId, message_id: '', user: 'system', user_id: 'system', ts: new Date().toISOString() },
  })

  // Finalize — keep build messages (they're the work product)
  if (state._heartbeat) clearInterval(state._heartbeat)
  if (state.timeout) clearTimeout(state.timeout)
  state.phase = 'complete'
  const feedbackCycles = Math.max(0, state.currentRound - 1)
  const concludedIds = await safeSend(state.ownerThreadId, formatStateLine('🔨', 'build', '⚒︎',
    `concluded — ${state.currentRound} round${state.currentRound > 1 ? 's' : ''}${feedbackCycles > 0 ? `, ${feedbackCycles} feedback cycle${feedbackCycles > 1 ? 's' : ''}` : ''}`))
  state.messageIds.push(...concludedIds)

  // Dump-without-strike: write transcript + transitions to disk, keep messages in thread
  const owner = registry.get(state.ownerSessionId)?.tmuxName ?? state.ownerSessionId
  const critic = state.criticSessionId ? registry.get(state.criticSessionId)?.tmuxName ?? state.criticSessionId : 'unknown'
  void dumpTranscript(state.ownerThreadId, 'build', state.messageIds, {
    task: state.task,
    rounds: `${state.currentRound}/${state.rounds}`,
    cast: `builder ${owner} · critic ${critic}`,
    outcome: approved ? 'approved' : 'max-rounds',
  }, state.statusHistory).then(path => {
    if (path) void safeSend(state.ownerThreadId, `_📼 transcript saved: \`${path}\`_`)
  }).catch(err => {
    process.stderr.write(`daemon: build transcript dump failed: ${err}\n`)
  })

  cleanupBuildMaps(state)
  refreshSessionVisual(state.ownerThreadId)
}

// ---------------------------------------------------------------------------
// Worktree cleanup (only on cancel — successful builds keep the worktree)
// ---------------------------------------------------------------------------

function cleanupWorktree(state: BuildState): void {
  if (!state.worktreeRepo || !state.worktreePath) return
  void destroyWorktree(state.worktreeRepo, state.worktreePath, state.worktreeBranch ?? '').catch(err => {
    process.stderr.write(`daemon: build worktree cleanup failed: ${err}\n`)
  })
}

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

async function spawnCritic(state: BuildState, implementationText: string): Promise<void> {
  const statusMsg = await gateway.send(state.ownerThreadId, `Spawning build critic...`)
  state.messageIds.push(statusMsg.id)

  // Get owner's cwd so critic knows where to find .claude/ directory
  const ownerInfo = registry.get(state.ownerSessionId)
  const ownerCwd = ownerInfo?.capabilities?.cwd

  const criticModel = state.engine === 'codex' ? state.model : (state.model ?? buildModel())
  try {
    const result = await doSpawnSession(`Build CRITIC (${state.rounds} rounds)`, undefined, undefined, withGuestToolScoping({
      trigger: 'build',
      joinThread: state.ownerThreadId,
      disallowedTools: [...PROTOCOL_GUEST_DISALLOWED_BUILTINS],
      ...(criticModel ? { model: criticModel } : {}),
      ...(state.engine ? { engine: state.engine } : {}),
      promptBuilder: (sessionId, tmuxName) =>
        buildCriticPrompt({ sessionId, tmuxName, rounds: state.rounds, threadId: state.ownerThreadId, task: state.task, ownerCwd, implementationText }),
    }))

    state.criticSessionId = result.sessionId
    sessionToBuild.set(result.sessionId, state.buildId)
    void gateway.delete(state.ownerThreadId, statusMsg.id).catch(() => {})
    state.messageIds = state.messageIds.filter(id => id !== statusMsg.id)
    await buildStatusLine(state)
    resetTimeout(state)
  } catch (err) {
    process.stderr.write(`daemon: build critic spawn failed: ${err instanceof Error ? err.message : String(err)}\n`)
    throw err
  }
}

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------

function resetTimeout(state: BuildState): void {
  if (state.timeout) clearTimeout(state.timeout)
  if (state._heartbeat) clearInterval(state._heartbeat)
  state._heartbeat = undefined

  const whose = state.phase === 'reviewing' ? 'critic' : 'owner'
  const timeoutMs = whose === 'critic' ? CRITIC_TIMEOUT_MS : OWNER_TIMEOUT_MS

  // Heartbeat: check critic tmux is alive every 5 min (silent unless dead)
  if (whose === 'critic' && state.criticSessionId) {
    let elapsed = 0
    state._heartbeat = setInterval(async () => {
      elapsed += 5
      const currentCriticId = state.criticSessionId
      if (!currentCriticId) return
      const criticInfo = registry.get(currentCriticId)
      if (criticInfo) {
        try {
          execFileSync('tmux', ['has-session', '-t', criticInfo.tmuxName], { stdio: 'pipe' })
          process.stderr.write(`daemon: build: critic ${criticInfo.tmuxName} alive (${elapsed}m elapsed)\n`)
        } catch (err) {
          process.stderr.write(`daemon: build: critic heartbeat check failed (${err}) — treating as critic death\n`)
          if (state._heartbeat) clearInterval(state._heartbeat)
          await gateway.send(state.ownerThreadId, `Build critic (${criticInfo.tmuxName}) died. Cancelling.`).catch(() => {})
          await cancelBuild(state.buildId)
        }
      }
    }, 5 * 60 * 1000)
  }

  state.timeout = setTimeout(async () => {
    if (state._heartbeat) clearInterval(state._heartbeat)
    process.stderr.write(`daemon: build turn timed out (${whose})\n`)
    const ci = state.criticSessionId ? registry.get(state.criticSessionId) : undefined
    const debugHint = ci ? ` Check \`tmux attach -t ${ci.tmuxName}\` to see what happened.` : ''
    await safeSend(state.ownerThreadId, `Build timed out waiting for ${whose}.${debugHint} Cancelling.`)
    await cancelBuild(state.buildId)
  }, timeoutMs)
}

export function onBuildDecision(sessionId: string, value: string, because: string): boolean {
  const buildId = sessionToBuild.get(sessionId)
  if (!buildId) return false
  const state = builds.get(buildId)
  if (!state || state.phase !== 'reviewing' || state.criticSessionId !== sessionId) return false

  const isApprove = value === 'approve'
  if (!isApprove && value !== 'request_changes') {
    process.stderr.write(`daemon: build decide: unknown value "${value}" (expected approve | request_changes)\n`)
    return false
  }

  const isFinal = !isApprove && state.currentRound >= state.rounds
  const event: BuildEvent = isApprove ? 'critic_lgtm' : isFinal ? 'critic_final' : 'critic_feedback'
  const result = buildMachine.transition(state.phase, event)
  if (!result.ok) return false

  void safeSend(state.ownerThreadId, `${CRITIC_SENTINEL}\n${isApprove ? '**LGTM**\n' : ''}${because}`).then(ids => {
    if (builds.has(state.buildId)) state.messageIds.push(...ids)
  })

  if (isApprove || isFinal) {
    state._closing = { approved: isApprove, lastCriticText: because }
    state.phase = result.to
    void requestBuildSummary(state, because, isApprove).catch(err => {
      process.stderr.write(`daemon: requestBuildSummary failed: ${err}\n`)
      void cancelBuild(state.buildId).catch(e => process.stderr.write(`daemon: cancelBuild failed: ${e}\n`))
    })
  } else {
    state.phase = result.to
    state.currentRound++
    onCriticFeedback(state, because)
  }
  return true
}

registerProtocol('build', {
  getByThread: (threadId) => !!getBuildByThread(threadId),
  isParticipant: isBuildParticipant,
  onReply: onBuildReply,
  onDisconnect: onBuildParticipantDisconnect,
  onReconnect: onBuildParticipantReconnect,
  onDecision: onBuildDecision,
  expectedTag: (sessionId, chatId) => {
    const buildId = sessionToBuild.get(sessionId) ?? ownerToBuild.get(sessionId)
    const state = buildId ? builds.get(buildId) : undefined
    if (!state || chatId !== state.ownerThreadId) return null
    if (state.phase === 'implementing' && sessionId === state.ownerSessionId) return BUILDER_SENTINEL
    if (state.phase === 'reviewing' && sessionId === state.criticSessionId) return CRITIC_SENTINEL
    if (state.phase === 'closing' && sessionId === state.ownerSessionId) return SUMMARY_SENTINEL
    return null
  },
})

export const __test = process.env.NODE_ENV === 'test'
  ? { builds, sessionToBuild, ownerToBuild, threadToBuild } as const
  : undefined
