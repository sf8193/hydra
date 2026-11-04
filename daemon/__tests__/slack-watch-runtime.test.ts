import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { writeFileSync, rmSync, utimesSync } from 'fs'
import { join } from 'path'
import { STATE_DIR } from '../config.js'
import { registry } from '../sessions.js'
import { setSpecialist, removeSpecialist } from '../specialists.js'
import { slackWatchConfigPath } from '../slack-watch.js'
import { getSlackWatcher, watchSlackThread, unwatchSlackThread, formatSlackWatches, slackWatchHealth } from '../slack-watch-runtime.js'
import { sessionCapabilities, isSlackSpecialistOccupant, isToolAllowed } from '../tool-surface.js'
import { handleCLIRequest, type CLIRequest } from '../cli-handler.js'

process.stderr.write = (() => true) as any

const SPECIALIST = 'slopbot-t'
const SPECIALIST_THREAD = 'specialist-thread-1'
let bump = 0
function configure(over: Record<string, unknown> = {}) {
  const path = slackWatchConfigPath()
  writeFileSync(path, JSON.stringify({ botUserId: 'UBOT', channels: ['C1'], specialist: SPECIALIST, coalesceMs: 5, maxWatches: 3, ...over }))
  // fileConfig caches on mtime: make every write look newer
  utimesSync(path, new Date(), new Date(Date.now() + 1000 * ++bump))
}
const occupant = { threadId: SPECIALIST_THREAD }
const stranger = { threadId: 'some-other-thread' }
let n = 0
const req = (command: string, params: Record<string, unknown>): CLIRequest => ({ type: 'cli', command, id: `sw-${++n}`, params })

const sessionIds: string[] = []
beforeEach(() => {
  configure()
  setSpecialist(SPECIALIST, { threadId: SPECIALIST_THREAD, kickoff: 'k' })
})
afterEach(() => {
  for (const e of getSlackWatcher().list()) getSlackWatcher().unwatch(e.channel, e.threadTs)
  for (const s of sessionIds.splice(0)) registry.delete(s)
  removeSpecialist(SPECIALIST)
  rmSync(slackWatchConfigPath(), { force: true })
  rmSync(join(STATE_DIR, 'slack-watches.json'), { force: true })
})

describe('the slack_specialist capability', () => {
  test('only a session in the specialist\'s thread has the watch tools', () => {
    expect(isSlackSpecialistOccupant(occupant)).toBe(true)
    expect(isSlackSpecialistOccupant(stranger)).toBe(false)
    expect(sessionCapabilities({ ...occupant, capabilities: [], engine: 'claude' } as any).has('slack_specialist')).toBe(true)
    expect(sessionCapabilities({ ...stranger, capabilities: [], engine: 'claude' } as any).has('slack_specialist')).toBe(false)

    const add = (id: string, threadId: string) => {
      sessionIds.push(id)
      registry.set(id, { sessionId: id, tmuxName: id, threadId, sessionType: 'thread_owner', engine: 'claude', createdAt: Date.now() } as any)
    }
    add('sw-in-specialist', SPECIALIST_THREAD)
    add('sw-elsewhere', 'some-other-thread')
    expect(isToolAllowed('sw-in-specialist', 'watch_slack_thread')).toBe(true)
    expect(isToolAllowed('sw-in-specialist', 'unwatch_slack_thread')).toBe(true)
    expect(isToolAllowed('sw-elsewhere', 'watch_slack_thread')).toBe(false)
    expect(isToolAllowed('main', 'watch_slack_thread')).toBe(false)
  })

  test('nothing is granted while Slack watching is unconfigured', () => {
    rmSync(slackWatchConfigPath())
    expect(isSlackSpecialistOccupant(occupant)).toBe(false)
  })
})

describe('watch_slack_thread / unwatch_slack_thread', () => {
  test('the specialist session watches and unwatches; the specialist is always the configured one', () => {
    expect(watchSlackThread(occupant, 'C1', '1793732224.093059')).toBe('watching C1:1793732224.093059')
    expect(getSlackWatcher().get('C1', '1793732224.093059')).toMatchObject({ specialist: SPECIALIST })
    expect(formatSlackWatches()[0]).toContain(`C1:1793732224.093059 → ${SPECIALIST}`)
    expect(unwatchSlackThread(occupant, 'C1', '1793732224.093059')).toBe('stopped watching C1:1793732224.093059')
    expect(unwatchSlackThread(occupant, 'C1', '1793732224.093059')).toContain('was not being watched')
  })

  test('another session, an unlisted channel, a malformed ts, and a full table are all refused', () => {
    expect(() => watchSlackThread(stranger, 'C1', '1.000001')).toThrow('only the session in the')
    expect(() => watchSlackThread(undefined, 'C1', '1.000001')).toThrow('only the session in the')
    expect(() => watchSlackThread(occupant, 'C_OTHER', '1.000001')).toThrow('channel must be one of')
    expect(() => watchSlackThread(occupant, 'C1', 'yesterday')).toThrow('thread_ts must look like')
    for (const ts of ['1.000001', '2.000001', '3.000001']) watchSlackThread(occupant, 'C1', ts)
    expect(() => watchSlackThread(occupant, 'C1', '4.000001')).toThrow('watch table is full')
    expect(() => unwatchSlackThread(stranger, 'C1', '1.000001')).toThrow('only the session in the')
  })

  test('without a config the tools say so instead of watching', () => {
    rmSync(slackWatchConfigPath())
    expect(() => watchSlackThread(occupant, 'C1', '1.000001')).toThrow('not configured')
  })
})

describe('operator view', () => {
  test('hydra slack-watch add / list / rm, and the health line', async () => {
    expect(await handleCLIRequest(req('slack-watch', { action: 'add', channel: 'C1', threadTs: '9.000001' }))).toMatchObject({ ok: true })
    const listed = await handleCLIRequest(req('slack-watch', { action: 'list' }))
    expect((listed.data as any).watches).toHaveLength(1)
    expect((listed.data as any).health).toMatchObject({ specialist: SPECIALIST, watches: 1, owed: 0, oldestOwedAgeMin: null })
    const health = await handleCLIRequest(req('health', {}))
    expect((health.data as any).slackWatch).toMatchObject({ specialist: SPECIALIST, watches: 1 })
    expect(await handleCLIRequest(req('slack-watch', { action: 'rm', channel: 'C1', threadTs: '9.000001' }))).toMatchObject({ ok: true })
    expect(await handleCLIRequest(req('slack-watch', { action: 'rm', channel: 'C1', threadTs: '9.000001' }))).toMatchObject({ ok: false })
    expect(await handleCLIRequest(req('slack-watch', { action: 'add', channel: 'C1', threadTs: 'nope' }))).toMatchObject({ ok: false })
  })

  test('health omits the line when nothing is configured', async () => {
    rmSync(slackWatchConfigPath())
    expect(slackWatchHealth()).toBeNull()
    const health = await handleCLIRequest(req('health', {}))
    expect((health.data as any).slackWatch).toBeUndefined()
    expect(await handleCLIRequest(req('slack-watch', { action: 'add', channel: 'C1', threadTs: '9.000001' }))).toMatchObject({ ok: false, error: expect.stringContaining('not configured') })
  })
})
