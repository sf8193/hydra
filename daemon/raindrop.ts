import { appendFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { join, basename } from 'path'
import { STATE_DIR, PLATFORM, RAINDROP_ENV, RAINDROP_DRYRUN_FILE } from './config.js'
import { loadAccess } from './access.js'
import { registry } from './sessions.js'
import { on } from './event-bus.js'
import { byteTmuxName, sentimentForReaction } from '../shared/constants.js'
import { setSweepFailureHandler } from '../shared/spawn-env.js'
import {
  buildEvent,
  buildSignal,
  EVENT_ENDPOINT,
  SIGNAL_ENDPOINT,
  type EventBody,
  type EventInput,
  type SignalBody,
  type SessionFacts,
} from './raindrop-payload.js'

export type RaindropMode = 'off' | 'dryrun' | 'live'

// Both endpoints take an array.
type WireBody = EventBody[] | SignalBody[]

const POST_TIMEOUT_MS = 5_000
const MODEL_FLAG = /--model[=\s]+['"]?([^'"\s]+)/
const HEADER_SAFE = /^[\x21-\x7E]+$/
const MODE_SHAPE = /^[a-z][a-z-]{0,11}$/
const MAIN_MODEL_TTL_MS = 10 * 60_000
const MAIN_MODEL_RETRY_MS = 60_000
const TRACKED_SWEEP_MS = 60_000
export const _TRACKED_MESSAGE_CAP = 1000

type TrackedMessage = { eventId: string; delivered: Promise<boolean>; signalled: Set<string> }

function rawWriteKey(): string {
  return (deps.env().RAINDROP_WRITE_KEY || '').trim()
}

function writeKey(): string {
  const raw = rawWriteKey()
  return HEADER_SAFE.test(raw) ? raw : ''
}

function rawMode(): string {
  return (deps.env().RAINDROP_MODE || '').trim().toLowerCase() || 'off'
}

type OmitRepoSetting = 'off' | 'on' | 'unrecognized'

function omitRepoSetting(): OmitRepoSetting {
  const raw = (deps.env().RAINDROP_OMIT_REPO || '').trim()
  if (raw === '') return 'off'
  return raw === '1' ? 'on' : 'unrecognized'
}

type RaindropState = { active: RaindropMode; reason?: string }

export function raindropState(): RaindropState {
  const raw = rawMode()
  const keyOnDisk = rawWriteKey() ? ', and RAINDROP_WRITE_KEY is still on disk' : ''
  if (raw === 'dryrun') return { active: 'dryrun' }
  if (raw === 'live') {
    if (writeKey()) return { active: 'live' }
    return {
      active: 'off',
      reason: rawWriteKey()
        ? 'RAINDROP_MODE=live but RAINDROP_WRITE_KEY has characters that cannot go in an HTTP header'
        : 'RAINDROP_MODE=live but RAINDROP_WRITE_KEY is unset',
    }
  }
  if (raw === 'off') {
    return {
      active: 'off',
      reason: keyOnDisk ? `RAINDROP_MODE is off or unset${keyOnDisk} — nothing is sent` : undefined,
    }
  }
  // Never echo an unrecognized value that could be a misplaced write key.
  return {
    active: 'off',
    reason: MODE_SHAPE.test(raw)
      ? `unrecognized RAINDROP_MODE='${raw}' (expected off|dryrun|live)${keyOnDisk}`
      : `unrecognized RAINDROP_MODE (expected off|dryrun|live)${keyOnDisk}`,
  }
}

type Drivers = Set<string> | 'unbounded'

export function drivableBy(access: { allowFrom?: string[]; groups?: Record<string, { allowFrom?: string[] }> }): Drivers {
  const users = new Set(access.allowFrom ?? [])
  for (const policy of Object.values(access.groups ?? {})) {
    const group = policy.allowFrom ?? []
    if (group.length === 0) return 'unbounded'
    for (const id of group) users.add(id)
  }
  return users
}

export function resolveUserId(drivers: Drivers): string {
  const explicit = (deps.env().RAINDROP_USER_ID || '').trim()
  if (explicit) return explicit
  if (drivers === 'unbounded') return ''
  return drivers.size === 1 ? drivers.values().next().value! : ''
}

export function parseModelFlag(paneCommand: string): string | undefined {
  return paneCommand.match(MODEL_FLAG)?.[1]
}

export function bytePaneArgv(): string[] {
  return ['list-panes', '-s', '-t', byteTmuxName(PLATFORM), '-F', '#{pane_start_command}']
}

const PROJECT_RETRY_MS = 60_000

type Cached<T> = { value: T; ok: boolean; at: number }

function stale<T>(entry: Cached<T> | undefined, now: number, okMs: number, failMs: number): boolean {
  return !entry || now - entry.at >= (entry.ok ? okMs : failMs)
}

const projectNames = new Map<string, Cached<string | undefined>>()

function readProjectName(repoPath: string): string | undefined {
  const now = deps.now()
  const cached = projectNames.get(repoPath)
  if (!stale(cached, now, Infinity, PROJECT_RETRY_MS)) return cached!.value
  const value = deps.projectFor(repoPath)
  projectNames.set(repoPath, { value, ok: value !== undefined, at: now })
  return value
}

export function projectFromGitDir(common: string): string | undefined {
  const parts = common.split('/').filter(Boolean)
  const last = parts[parts.length - 1]
  if (!last) return undefined
  if (last === '.git') return parts[parts.length - 2]
  return last.endsWith('.git') ? last.slice(0, -4) : last
}

export function defaultProjectFor(repoPath: string): string | undefined {
  // Bun.spawnSync throws rather than returning a code when git is absent, and
  // this runs inside register(), whose throw would leave the daemon half-booted.
  try {
    const proc = Bun.spawnSync(
      ['git', '-C', repoPath, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { stdout: 'pipe', stderr: 'ignore', timeout: 2000 },
    )
    if (proc.exitCode !== 0) return undefined
    const common = proc.stdout.toString().trim()
    return common ? projectFromGitDir(common) : undefined
  } catch { return undefined }
}

function readBytePaneCommand(): string {
  try {
    return execFileSync('tmux', bytePaneArgv(), { stdio: ['pipe', 'pipe', 'pipe'], timeout: 2000 }).toString()
  } catch { return '' }
}

let mainModelCache: Cached<string | undefined> | undefined

export type RaindropDeps = {
  factsFor: (sessionId: string) => SessionFacts | undefined
  bytePaneCommand: () => string
  liveSessionIds: () => string[]
  postEvent: (endpoint: string, body: WireBody) => Promise<void>
  recordDryRun: (endpoint: string, body: WireBody) => void
  allowedUsers: () => Drivers
  projectFor: (repoPath: string) => string | undefined
  env: () => Record<string, string | undefined>
  now: () => number
}

export function factsForMain(now: number): SessionFacts {
  if (stale(mainModelCache, now, MAIN_MODEL_TTL_MS, MAIN_MODEL_RETRY_MS)) {
    const paneCommand = deps.bytePaneCommand()
    mainModelCache = paneCommand
      ? { value: parseModelFlag(paneCommand), ok: true, at: now }
      : { value: mainModelCache?.value, ok: false, at: now }
  }
  return {
    threadId: '',
    createdAt: 0,
    tmuxName: 'main',
    engine: 'claude',
    model: mainModelCache?.value,
    sessionType: 'master_orchestrator',
    platform: PLATFORM,
  }
}

export function factsFromRegistry(sessionId: string): SessionFacts | undefined {
  const info = registry.get(sessionId)
  if (!info || info.headless) return undefined
  return {
    threadId: info.threadId,
    createdAt: info.createdAt,
    tmuxName: info.tmuxName,
    engine: info.engine,
    model: info.sessionMetadata?.model,
    sessionType: info.sessionType,
    originType: info.originType,
    platform: PLATFORM,
    project: info.worktreeRepo && readProjectName(info.worktreeRepo),
  }
}

export async function post(endpoint: string, body: WireBody): Promise<void> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${writeKey()}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(POST_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`raindrop: ${endpoint} returned ${res.status} ${res.statusText}`)
}

export function defaultLiveSessionIds(): string[] {
  return [...registry.values()].filter(s => !s.deadAt).map(s => s.sessionId)
}

export function defaultAllowedUsers(): Drivers {
  // Empty, not 'unbounded': a malformed group must not read as "admits everyone".
  try { return drivableBy(loadAccess()) } catch { return new Set() }
}

const defaultDeps: RaindropDeps = {
  factsFor: factsFromRegistry,
  bytePaneCommand: readBytePaneCommand,
  liveSessionIds: defaultLiveSessionIds,
  postEvent: post,
  recordDryRun: (endpoint: string, body: WireBody) => {
    appendFileSync(RAINDROP_DRYRUN_FILE, `${JSON.stringify({ endpoint, body })}\n`, { mode: 0o600 })
  },
  allowedUsers: defaultAllowedUsers,
  projectFor: defaultProjectFor,
  env: () => RAINDROP_ENV,
  now: () => Date.now(),
}

let deps: RaindropDeps = defaultDeps

export function _setDeps(custom: Partial<RaindropDeps>): void { deps = { ...defaultDeps, ...custom } }
export function _resetDeps(): void { deps = defaultDeps }

const tracked = new Map<string, SessionFacts>()
const messageEvents = new Map<string, TrackedMessage>()

export function _trackedSizeForTesting(): number { return tracked.size }

export function _resetStateForTesting(): void {
  projectNames.clear()
  tracked.clear()
  messageEvents.clear()
  mainModelCache = undefined
  counters = zeroCounters()
}

function rememberMessages(ids: string[], entry: TrackedMessage): void {
  for (const id of ids) messageEvents.set(id, entry)
  while (messageEvents.size > _TRACKED_MESSAGE_CAP) {
    messageEvents.delete(messageEvents.keys().next().value!)
  }
}

type Counters = {
  sent: number; lastSentAt: number
  failures: number; lastFailureAt: number
  sweepFailures: number; lastSweepFailureAt: number
}
const zeroCounters = (): Counters => ({
  sent: 0, lastSentAt: 0, failures: 0, lastFailureAt: 0, sweepFailures: 0, lastSweepFailureAt: 0,
})
let counters = zeroCounters()

function ago(at: number): string { return `${Math.round((deps.now() - at) / 60_000)}m ago` }

function failureVerb(active: RaindropMode): { short: string; long: string } {
  return active === 'live'
    ? { short: 'send', long: 'send failure' }
    : { short: 'write', long: 'write error' }
}

export function raindropStatusLine(surface: 'cli' | 'chat'): string | undefined {
  const { active, reason } = raindropState()
  if (active === 'off') return reason && `disabled — ${reason}`
  const where = active === 'live' ? 'api.raindrop.ai'
    : surface === 'cli' ? RAINDROP_DRYRUN_FILE : basename(RAINDROP_DRYRUN_FILE)
  const verb = failureVerb(active).long
  const drivers = deps.allowedUsers()
  const detail: string[] = []
  const omit = omitRepoSetting()
  if (omit === 'on') detail.push('repo omitted')
  if (omit === 'unrecognized') detail.push('RAINDROP_OMIT_REPO not understood — expected literal 1, repo omitted anyway')
  const user = resolveUserId(drivers)
  if (!user) {
    detail.push(drivers !== 'unbounded' && drivers.size === 0
      ? 'no allowlisted user — nobody is paired, or access.json was reset'
      : 'no attributable user — set RAINDROP_USER_ID')
  } else if (drivers !== 'unbounded' && !drivers.has(user)) {
    detail.push(`RAINDROP_USER_ID=${user} is not an allowlisted user — events are attributed to nobody real and no reaction of yours becomes a signal`)
  }
  const { sent, lastSentAt, failures, lastFailureAt, sweepFailures, lastSweepFailureAt } = counters
  detail.push(sent === 0 ? 'nothing recorded yet' : `${sent} recorded, last ${ago(lastSentAt)}`)
  if (failures > 0) detail.push(`${failures} ${verb}${failures === 1 ? '' : 's'}, last ${ago(lastFailureAt)}`)
  if (sweepFailures > 0) {
    detail.push(`${sweepFailures} tmux env sweep failure${sweepFailures === 1 ? '' : 's'} — a pane may hold the write key, last ${ago(lastSweepFailureAt)}`)
  }
  return `${active} → ${where} (${detail.join('; ')})`
}

export function register(): () => void {
  const { active } = raindropState()
  const line = raindropStatusLine('cli')
  if (line) process.stderr.write(`daemon: raindrop: ${line}\n`)
  if (active === 'off') return () => {}
  const live = active === 'live'

  const onError = (err: unknown) => {
    counters.failures++
    counters.lastFailureAt = deps.now()
    const verb = failureVerb(active).short
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err)
    process.stderr.write(`daemon: raindrop: ${verb} failed (${counters.failures}): ${msg}\n`)
  }

  // The registry outlives the daemon; this map does not.
  for (const sessionId of deps.liveSessionIds()) {
    const facts = deps.factsFor(sessionId)
    if (facts) tracked.set(sessionId, facts)
  }

  const dispatch = async (endpoint: string, wire: WireBody): Promise<boolean> => {
    try {
      if (live) await deps.postEvent(endpoint, wire)
      else deps.recordDryRun(endpoint, wire)
      counters.sent++
      counters.lastSentAt = deps.now()
      return true
    } catch (err) { onError(err); return false }
  }

  const track = async (input: Omit<EventInput, 'userId' | 'omitRepo'>): Promise<boolean> => {
    const user = resolveUserId(deps.allowedUsers())
    if (!user) return false
    const body = buildEvent({ ...input, userId: user, omitRepo: omitRepoSetting() !== 'off' })
    if (!body) {
      onError(new Error(`refused to build ${input.event}: event_id or user_id failed its shape gate`))
      return false
    }
    return dispatch(EVENT_ENDPOINT, [body])
  }

  setSweepFailureHandler((reason) => {
    counters.sweepFailures++
    counters.lastSweepFailureAt = deps.now()
    void track({
      event: 'hydra.env.sweep_failed',
      eventId: `sweep:${deps.now()}`,
      facts: { threadId: '', createdAt: deps.now(), platform: PLATFORM },
      threadId: '',
      at: deps.now(),
      extra: { reason },
    })
  })

  const sweep = setInterval(() => {
    const live = new Set(deps.liveSessionIds())
    for (const id of tracked.keys()) if (!live.has(id)) tracked.delete(id)
  }, TRACKED_SWEEP_MS)
  sweep.unref()

  const unsubs = [
    on('session:bridge-registered', async ({ sessionId }) => {
      const facts = deps.factsFor(sessionId)
      if (!facts) return
      const firstSeen = !tracked.has(sessionId)
      tracked.set(sessionId, facts)
      if (!firstSeen) return
      await track({
        event: 'hydra.session.spawn', eventId: sessionId, facts,
        threadId: facts.threadId, at: facts.createdAt,
      })
    }, 'raindrop:spawn', { onError }),

    on('reply', async ({ sessionId, text, chatId, sentIds }) => {
      const facts = sessionId === 'main' ? factsForMain(deps.now()) : deps.factsFor(sessionId)
      if (!facts) return
      if (sessionId !== 'main') tracked.set(sessionId, facts)
      const threadId = sessionId === 'main' ? chatId : facts.threadId
      const eventId = sentIds[sentIds.length - 1] ?? `${sessionId}:${deps.now()}`
      const delivered = track({
        event: 'hydra.session.reply', eventId, facts, threadId,
        at: deps.now(), replyChars: text.length,
      })
      rememberMessages(sentIds, { eventId, delivered, signalled: new Set() })
      await delivered
    }, 'raindrop:reply', { onError }),

    on('session:death', async ({ sessionId, deadAt }) => {
      const facts = tracked.get(sessionId)
      tracked.delete(sessionId)
      if (!facts) return
      await track({
        event: 'hydra.session.death', eventId: `${sessionId}:death`, facts,
        threadId: facts.threadId, at: deadAt ?? deps.now(),
      })
    }, 'raindrop:death', { onError }),

    on('reaction', async ({ messageId, userId: reactorId, emoji }) => {
      const signal = sentimentForReaction(emoji)
      if (!signal) return
      const entry = messageEvents.get(messageId)
      if (!entry) return
      // Membership is not identity: a second driver is not the attributed user.
      const user = resolveUserId(deps.allowedUsers())
      if (!user || reactorId !== user) return
      if (entry.signalled.has(signal.name)) return
      entry.signalled.add(signal.name)
      if (!await entry.delivered) return
      const ok = await dispatch(SIGNAL_ENDPOINT, [buildSignal(entry.eventId, signal.name, signal.sentiment)])
      if (!ok) entry.signalled.delete(signal.name)
    }, 'raindrop:reaction-signal', { onError }),
  ]

  return () => { setSweepFailureHandler(null); clearInterval(sweep); for (const unsub of unsubs) unsub() }
}
