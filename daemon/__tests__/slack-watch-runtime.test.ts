import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { writeFileSync, rmSync, utimesSync } from 'fs'
import { join } from 'path'
import { STATE_DIR, gateway } from '../config.js'
import { noteMainChannel } from '../main-session.js'
import { registry } from '../sessions.js'
import { setSpecialist, removeSpecialist } from '../specialists.js'
import { slackWatchConfigPath } from '../slack-watch.js'
import { getSlackWatcher, watchSlackThread, unwatchSlackThread, formatSlackWatches, slackWatchHealth } from '../slack-watch-runtime.js'
import { sessionCapabilities, isSlackSpecialistOccupant, isToolAllowed } from '../tool-surface.js'
import { handleCLIRequest, type CLIRequest } from '../cli-handler.js'
import { executeTool } from '../bridge-dispatch.js'

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
    expect(getSlackWatcher().get('C1', '1793732224.093059')).toMatchObject({ mentionedBy: 'tool' })
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

describe('routes in the runtime', () => {
  const OPS = 'ops-t'
  const OPS_THREAD = 'ops-thread-1'
  beforeEach(() => setSpecialist(OPS, { threadId: OPS_THREAD, kickoff: 'k' }))
  afterEach(() => removeSpecialist(OPS))
  const routed = () => configure({ channels: undefined, specialist: undefined, routes: [{ channels: ['C1'], to: SPECIALIST, from: 'anyone' }, { channels: ['C2'], to: OPS, from: 'anyone' }] })

  test("each route's session gets the watch tools, for its own route's channels only", () => {
    routed()
    expect(isSlackSpecialistOccupant({ threadId: OPS_THREAD })).toBe(true)
    expect(isSlackSpecialistOccupant(occupant)).toBe(true)
    expect(watchSlackThread({ threadId: OPS_THREAD }, 'C2', '1.000001')).toBe('watching C2:1.000001')
    expect(() => watchSlackThread({ threadId: OPS_THREAD }, 'C1', '1.000001')).toThrow(`only the session in the "${SPECIALIST}" specialist may watch Slack threads in C1`)
    expect(formatSlackWatches().find(l => l.startsWith('C2:'))).toContain(`→ ${OPS}`)
  })

  test("list_watches: a route's session sees its own route's Slack threads, never another route's", async () => {
    routed()
    for (const [id, threadId] of [['sw-food', SPECIALIST_THREAD], ['sw-ops', OPS_THREAD], ['sw-none', 'some-other-thread']] as const) {
      sessionIds.push(id)
      registry.set(id, { sessionId: id, tmuxName: id, threadId, sessionType: 'thread_owner', engine: 'claude', createdAt: Date.now() } as any)
    }
    getSlackWatcher().watch('C1', '11.000001')
    getSlackWatcher().watch('C2', '22.000001')
    const seen = async (id: string) => ((await executeTool('list_watches', {}, id)).content[0] as { text: string }).text
    expect(await seen('sw-food')).toContain('C1:11.000001')
    expect(await seen('sw-food')).not.toContain('C2:')
    expect(await seen('sw-ops')).toContain('C2:22.000001')
    expect(await seen('sw-ops')).not.toContain('C1:')
    expect(await seen('sw-none')).not.toContain('slack')
  })

  test('a route to main is flagged in slack-watch list: never revived, its queue not durable', async () => {
    configure({ channels: undefined, specialist: undefined, routes: [{ channels: ['C1'], to: 'main', from: 'anyone' }] })
    const listed = await handleCLIRequest(req('slack-watch', { action: 'list' }))
    expect((listed.data as any).health.routes).toEqual([{ channels: ['C1'], to: 'main', note: expect.stringContaining('never revived') }])
  })

  test('a route to main delivers only while main is connected; otherwise its messages stay owed', async () => {
    configure({ channels: undefined, specialist: undefined, routes: [{ channels: ['C1'], to: 'main', from: 'anyone' }] })
    const w = getSlackWatcher()
    w.handle({ channel: 'C1', ts: '71.000001', user: 'UA', text: '<@UBOT> hi' })
    await w.flush()
    expect(w.get('C1', '71.000001')?.owed).toEqual(['71.000001'])
  })

  test("a drop in a route to main is alerted in main's channel, not lost to stderr", async () => {
    noteMainChannel('C0MAINCH')
    const posted: { channel: string; text: string }[] = []
    const realSend = gateway.send
    ;(gateway as any).send = async (channel: string, text: string) => { posted.push({ channel, text }); return 'id' }
    try {
      configure({ channels: undefined, specialist: undefined, maxWatches: 1, routes: [{ channels: ['C1'], to: 'main', from: 'anyone' }] })
      const w = getSlackWatcher()
      w.handle({ channel: 'C1', ts: '80.000001', user: 'UA', text: '<@UBOT> one' })
      w.handle({ channel: 'C1', ts: '81.000001', user: 'UA', text: '<@UBOT> two' }) // table-full
      await Bun.sleep(10)
      expect(posted.some(p => p.channel === 'C0MAINCH' && p.text.includes('table-full'))).toBe(true)
      w.close()
    } finally { (gateway as any).send = realSend }
  })

  test('slack-watch list flags a route to an undeclared specialist before anything is owed to it', async () => {
    configure({ channels: undefined, specialist: undefined, routes: [{ channels: ['C1'], to: 'nobody-here', from: 'anyone' }] })
    const listed = await handleCLIRequest(req('slack-watch', { action: 'list' }))
    expect((listed.data as any).health.routes[0].note).toContain('no such specialist: nobody-here')
  })

  test('a route naming no such specialist keeps its messages owed', async () => {
    configure({ channels: undefined, specialist: undefined, routes: [{ channels: ['C1'], to: 'nobody-here', from: 'anyone' }] })
    const w = getSlackWatcher()
    w.handle({ channel: 'C1', ts: '70.000001', user: 'UA', text: '<@UBOT> hi' })
    await w.flush()
    expect(w.get('C1', '70.000001')?.owed).toEqual(['70.000001'])
  })
})

describe('operator view', () => {
  test('hydra slack-watch add / list / rm, and the health line', async () => {
    expect(await handleCLIRequest(req('slack-watch', { action: 'add', channel: 'C1', threadTs: '9.000001' }))).toMatchObject({ ok: true })
    const listed = await handleCLIRequest(req('slack-watch', { action: 'list' }))
    expect((listed.data as any).watches).toHaveLength(1)
    expect((listed.data as any).health).toMatchObject({ routes: [{ channels: ['C1'], to: SPECIALIST }], watches: 1, owed: 0, oldestOwedAgeMin: null })
    const health = await handleCLIRequest(req('health', {}))
    expect((health.data as any).slackWatch).toMatchObject({ routes: [{ to: SPECIALIST }], watches: 1 })
    expect(await handleCLIRequest(req('slack-watch', { action: 'rm', channel: 'C1', threadTs: '9.000001' }))).toMatchObject({ ok: true })
    expect(await handleCLIRequest(req('slack-watch', { action: 'rm', channel: 'C1', threadTs: '9.000001' }))).toMatchObject({ ok: false })
    expect(await handleCLIRequest(req('slack-watch', { action: 'add', channel: 'C1', threadTs: 'nope' }))).toMatchObject({ ok: false })
    expect(await handleCLIRequest(req('slack-watch', { action: 'add', channel: 'C_ELSEWHERE', threadTs: '9.000002' }))).toMatchObject({ ok: false, error: expect.stringContaining('is in no route') })
  })

  test('slack-watch list counts refusals by sender, and drops by kind', async () => {
    configure({ people: { UOWNER: { role: 'owner' } }, maxWatches: 1 })
    const before = (await handleCLIRequest(req('slack-watch', { action: 'list' }))).data as any
    const w = getSlackWatcher()
    expect(w.handle({ channel: 'C1', ts: '50.000001', user: 'USTRANGER', text: '<@UBOT> hi' })).toBe('refused')
    w.handle({ channel: 'C1', ts: '51.000001', user: 'UOWNER', text: '<@UBOT> one' })
    w.handle({ channel: 'C1', ts: '52.000001', user: 'UOWNER', text: '<@UBOT> two' }) // the table holds one
    const after = (await handleCLIRequest(req('slack-watch', { action: 'list' }))).data as any
    expect(after.health.refused - before.health.refused).toBe(1)
    expect(after.health.refusedBy.USTRANGER - (before.health.refusedBy.USTRANGER ?? 0)).toBe(1)
    expect(after.health.dropped['table-full'] - (before.health.dropped['table-full'] ?? 0)).toBe(1)
    w.close()
  })

  test('health omits the line when nothing is configured', async () => {
    rmSync(slackWatchConfigPath())
    expect(slackWatchHealth()).toBeNull()
    const health = await handleCLIRequest(req('health', {}))
    expect((health.data as any).slackWatch).toBeUndefined()
    expect(await handleCLIRequest(req('slack-watch', { action: 'add', channel: 'C1', threadTs: '9.000001' }))).toMatchObject({ ok: false, error: expect.stringContaining('not configured') })
  })
})
