import { execSync, execFileSync } from 'child_process'
import { resolve } from 'path'
import { gateway } from './config.js'
import { registry } from './sessions.js'
import { doSpawnSession, killSession, killsInProgress } from './session-lifecycle.js'
import { transport } from './bridge-transport.js'
import { registerProtocol, isThreadOccupied } from './protocol-registry.js'
import { buildOwnerPrompt } from './prompts/build-owner.js'
import { buildCriticPrompt } from './prompts/build-critic.js'
import { refreshSessionVisual, registerProtocolBadge, formatRoundBadge } from './anchor-state.js'
import { createStateMachine } from './state-machine.js'
import { buildModel, resolveModelAlias } from '../shared/constants.js'

const shq = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'"

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
  | 'complete'
  | 'cancelled'

export type BuildState = {
  buildId: string
  ownerThreadId: string
  ownerSessionId: string
  criticSessionId?: string
  task: string
  rounds: number
  currentRound: number
  phase: BuildPhase
  messageIds: string[]
  timeout?: ReturnType<typeof setTimeout>
  _heartbeat?: ReturnType<typeof setInterval>
  _criticDisconnectTimer?: ReturnType<typeof setTimeout>
  _ownerDisconnectTimer?: ReturnType<typeof setTimeout>
  worktreeRepo?: string
  worktreePath?: string
  worktreeBranch?: string
  model?: string
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const builds = new Map<string, BuildState>()
const sessionToBuild = new Map<string, string>()  // critic -> buildId
const ownerToBuild = new Map<string, string>()     // owner -> buildId
const threadToBuild = new Map<string, string>()    // thread -> buildId

const CRITIC_TIMEOUT_MS = 20 * 60 * 1000
const OWNER_TIMEOUT_MS = 30 * 60 * 1000

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

type BuildEvent = 'owner_impl' | 'critic_lgtm' | 'critic_feedback' | 'timeout' | 'cancel'

export const buildMachine = createStateMachine<BuildPhase, BuildEvent>('build', {
  implementing: { owner_impl: 'reviewing',    timeout: 'cancelled', cancel: 'cancelled' },
  reviewing:    { critic_lgtm: 'complete', critic_feedback: 'implementing', timeout: 'cancelled', cancel: 'cancelled' },
  complete:     {},
  cancelled:    {},
})

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

registerProtocolBadge(threadId => {
  const state = getBuildByThread(threadId)
  if (!state) return undefined
  const half = state.phase === 'implementing' ? 'top' : 'bottom'
  return formatRoundBadge('🔨', half, state.currentRound, state.rounds)
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
    const repoDir = resolve(spawnCwd, worktreeTarget)

    try {
      execSync(`git -C ${shq(repoDir)} rev-parse --git-dir`, { stdio: 'pipe' })
    } catch {
      throw new Error(`worktree target "${worktreeTarget}" is not a git repo at ${repoDir}`)
    }

    const branch = taskToBranchName(task ?? 'build')
    const wtDir = resolve(repoDir, '..', '.worktrees', `${worktreeTarget}-build-${buildId}`)

    try { execSync(`git -C ${shq(repoDir)} worktree remove ${shq(wtDir)} --force 2>/dev/null`, { stdio: 'pipe' }) } catch {}
    try { execSync(`git -C ${shq(repoDir)} worktree prune 2>/dev/null`, { stdio: 'pipe' }) } catch {}
    try { execSync(`git -C ${shq(repoDir)} branch -D ${shq(branch)} 2>/dev/null`, { stdio: 'pipe' }) } catch {}

    try {
      execFileSync('git', ['-C', repoDir, 'worktree', 'add', '-b', branch, wtDir], { stdio: 'pipe' })
      process.stderr.write(`daemon: build worktree created at ${wtDir} (branch ${branch})\n`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`failed to create build worktree: ${msg}`)
    }

    worktreeRepo = repoDir
    worktreePath = wtDir
    worktreeBranch = branch
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
  }

  builds.set(buildId, state)
  threadToBuild.set(ownerThreadId, buildId)
  ownerToBuild.set(ownerSessionId, buildId)
  refreshSessionVisual(ownerThreadId, { badge: formatRoundBadge('🔨', 'top', state.currentRound, state.rounds) })

  try {
    const taskLine = task ? `\nTask: **${task}**` : ''
    const wtLine = worktreePath ? `\nWorktree: \`${worktreePath}\`` : ''
    const ann = await gateway.send(ownerThreadId, [
      `**Build** — ${rounds} round${rounds > 1 ? 's' : ''}`,
      `Owner implements, critic reviews.${taskLine}${wtLine}`,
    ].join('\n'))
    state.messageIds.push(ann.id)

    // Tell owner to start implementing
    transport.sendOrQueue(ownerSessionId, {
      type: 'notification',
      content: buildOwnerPrompt({ rounds, task, buildId, worktreePath }),
      meta: { chat_id: ownerThreadId, message_id: '', user: 'system', user_id: 'system', ts: new Date().toISOString() },
    })

    // Spawn critic
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

  state.phase = 'cancelled'
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
  await gateway.send(state.ownerThreadId, `Build cancelled.`)

  cleanupWorktree(state)
}

// ---------------------------------------------------------------------------
// Core reply handler — called from bridge-server for ALL reply tool calls
// ---------------------------------------------------------------------------

const BUILDER_SENTINEL = '[builder→critic]'
const CRITIC_SENTINEL = '[critic→builder]'

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
    const event: BuildEvent = isLgtm ? 'critic_lgtm' : 'critic_feedback'
    const result = buildMachine.transition(state.phase, event)
    if (!result.ok) return

    state.messageIds.push(...sentMessageIds)
    if (isLgtm) {
      void finishBuild(state, bodyText).catch(err => {
        process.stderr.write(`daemon: finishBuild failed: ${err}\n`)
        void cancelBuild(state.buildId).catch(e => process.stderr.write(`daemon: cancelBuild failed: ${e}\n`))
      })
    } else if (state.currentRound >= state.rounds) {
      void finishBuild(state, bodyText).catch(err => {
        process.stderr.write(`daemon: finishBuild failed: ${err}\n`)
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
  if (transport.has(sessionId)) return

  if (state.criticSessionId === sessionId) {
    process.stderr.write(`daemon: build critic disconnected — 30s grace period\n`)
    if (state.timeout) {
      clearTimeout(state.timeout)
      state.timeout = undefined
    }
    state._criticDisconnectTimer = setTimeout(async () => {
      process.stderr.write(`daemon: build critic did not reconnect, cancelling build\n`)
      void cancelBuild(state.buildId).catch(e => process.stderr.write(`daemon: cancelBuild failed: ${e}\n`))
    }, 30_000)
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
  const badge = formatRoundBadge('🔨', 'bottom', state.currentRound, state.rounds)

  // Post visible status
  void gateway.send(state.ownerThreadId, `_${badge} Critic reviewing (${roundLabel})..._`).then(msg => {
    state.messageIds.push(msg.id)
  }).catch(() => {})

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
  const badge = formatRoundBadge('🔨', 'top', state.currentRound, state.rounds)

  // Post visible status so the human knows it's the builder's turn
  void gateway.send(state.ownerThreadId, `_${badge} Critic found issues. Builder's turn to fix (${roundLabel})._`).catch(() => {})

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

async function finishBuild(state: BuildState, lastCriticText: string): Promise<void> {
  // Kill critic — delete from map BEFORE nulling the field
  if (state.criticSessionId) {
    sessionToBuild.delete(state.criticSessionId)
    try {
      const info = registry.get(state.criticSessionId)
      if (info && !killsInProgress.has(state.criticSessionId)) {
        await killSession(info, 'build complete')
      }
    } catch (err) {
      process.stderr.write(`daemon: build finishBuild killSession failed: ${err}\n`)
    }
    state.criticSessionId = undefined
  }

  const firstLine = lastCriticText.split('\n')[0].trim()
  const approved = firstLine === '**LGTM**' || firstLine === 'LGTM'

  completeBuild(state, approved, lastCriticText)
}

function completeBuild(state: BuildState, approved: boolean, lastCriticText: string): void {
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
  cleanupBuildMaps(state)
  refreshSessionVisual(state.ownerThreadId)
}

// ---------------------------------------------------------------------------
// Worktree cleanup (only on cancel — successful builds keep the worktree)
// ---------------------------------------------------------------------------

function cleanupWorktree(state: BuildState): void {
  if (!state.worktreeRepo || !state.worktreePath) return
  try {
    execSync(`git -C ${shq(state.worktreeRepo)} worktree remove ${shq(state.worktreePath)} --force`, { stdio: 'pipe' })
    process.stderr.write(`daemon: build worktree removed: ${state.worktreePath}\n`)
  } catch (err) {
    process.stderr.write(`daemon: build worktree removal failed: ${err instanceof Error ? err.message : String(err)}\n`)
  }
  try { execSync(`git -C ${shq(state.worktreeRepo)} worktree prune`, { stdio: 'pipe' }) } catch {}
  if (state.worktreeBranch) {
    try {
      execSync(`git -C ${shq(state.worktreeRepo)} branch -D ${shq(state.worktreeBranch)}`, { stdio: 'pipe' })
      process.stderr.write(`daemon: build branch deleted: ${state.worktreeBranch}\n`)
    } catch {}
  }
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

  const criticModel = state.model ?? buildModel()
  try {
    const result = await doSpawnSession(`Build CRITIC (${state.rounds} rounds)`, undefined, undefined, {
      joinThread: state.ownerThreadId,
      model: criticModel,
      promptBuilder: (sessionId, tmuxName) =>
        buildCriticPrompt({ sessionId, tmuxName, rounds: state.rounds, threadId: state.ownerThreadId, task: state.task, ownerCwd, implementationText }),
    })

    state.criticSessionId = result.sessionId
    sessionToBuild.set(result.sessionId, state.buildId)
    void gateway.edit(state.ownerThreadId, statusMsg.id, `_Critic (**${result.name}**) reviewing..._`).catch(() => {})
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`daemon: build critic spawn failed: ${msg}\n`)
    await gateway.send(state.ownerThreadId, `Failed to spawn build critic: ${msg}. Build cancelled.`)
    void cancelBuild(state.buildId)
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
          execSync(`tmux has-session -t '${criticInfo.tmuxName}' 2>/dev/null`, { stdio: 'pipe' })
          process.stderr.write(`daemon: build: critic ${criticInfo.tmuxName} alive (${elapsed}m elapsed)\n`)
        } catch {
          process.stderr.write(`daemon: build critic tmux session died\n`)
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
    await gateway.send(state.ownerThreadId, `Build timed out waiting for ${whose}.${debugHint} Cancelling.`)
    await cancelBuild(state.buildId)
  }, timeoutMs)
}

registerProtocol('build', {
  getByThread: (threadId) => !!getBuildByThread(threadId),
  isParticipant: isBuildParticipant,
  onReply: onBuildReply,
  onDisconnect: onBuildParticipantDisconnect,
  onReconnect: onBuildParticipantReconnect,
})

