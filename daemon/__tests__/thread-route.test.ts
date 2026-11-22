// A session's thread is one the gateway can address. A record that stored its session id as its thread (lark, 11-11) failed every
// post to it for days; these pin each place that refuses, routes or reports such an id.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { gateway } from '../../infra/config.js'
import { registry } from '../../sessions/registry.js'
import { backfillAnchorChannelIds } from '../../app/session-lifecycle.js'
import { refreshSessionVisual } from '../../sessions/anchor-state.js'
import { safeSend } from '../../infra/util.js'
import { routeThreadId, reportUnaddressableThreads } from '../../sessions/thread-route.js'
import { DiscordGateway, isDiscordThreadId } from '../../gateways/discord.js'
import { isSlackThreadId } from '../../gateways/slack.js'

const SID = '472d35be-061a-43d8-bd50-eba33b094694'
const SID2 = '3fde2540-e5de-4862-abe8-d4b315b8bfec'
const SNOWFLAKE = '1567260167517503609'

let log = ''
const realWrite = process.stderr.write.bind(process.stderr)
const orig: Record<string, any> = {}
const calls = { send: [] as string[], fetchChannel: [] as string[], visual: [] as string[], createThread: 0 }

beforeAll(() => {
  process.stderr.write = ((s: string) => { log += s; return true }) as any
  for (const k of ['send', 'fetchChannel', 'getThreadUrl', 'createThread', 'updateSessionVisual'] as const) orig[k] = (gateway as any)[k]
  orig.persist = registry.persist
  ;(registry as any).persist = () => {}
  ;(gateway as any).send = async (c: string) => { calls.send.push(c); return { id: 'm1', channelId: c } }
  ;(gateway as any).fetchChannel = async (id: string) => { calls.fetchChannel.push(id); return { isThread: id !== 'P', isDM: false, parentId: id === 'P' ? null : 'P' } }
  ;(gateway as any).getThreadUrl = async (id: string) => `https://x/${id}`
  ;(gateway as any).createThread = async () => { calls.createThread++; return { id: SID } }
  ;(gateway as any).updateSessionVisual = async (id: string) => { calls.visual.push(id) }
})
afterAll(() => {
  process.stderr.write = realWrite as any
  for (const k of ['send', 'fetchChannel', 'getThreadUrl', 'createThread', 'updateSessionVisual'] as const) (gateway as any)[k] = orig[k]
  ;(registry as any).persist = orig.persist
})
afterEach(() => {
  log = ''
  calls.send.length = 0; calls.fetchChannel.length = 0; calls.visual.length = 0; calls.createThread = 0
  for (const s of [...registry.values()]) if (s.sessionId.startsWith('tr-')) registry.delete(s.sessionId)
})

let n = 0
function session(over: Record<string, unknown>) {
  const id = `tr-${++n}`
  const rec = { sessionId: id, tmuxName: `s${n}`, threadId: SNOWFLAKE, createdAt: Date.now(), lastActive: Date.now(), listening: true, sessionType: 'thread_owner', adapter: { isAlive: () => true, isConnected: () => true }, ...over } as any
  registry.set(id, rec)
  if (rec.threadId) registry.setThread(rec.threadId, id)
  return rec
}

describe('what the gateways call a thread id', () => {
  test('Discord: a snowflake, never a session id, a name or a stub', () => {
    expect(isDiscordThreadId(SNOWFLAKE)).toBe(true)
    for (const bad of [SID, 'test-thread-91d1dde1', 'lark', '', '123', `${SNOWFLAKE}:1.2`]) expect(isDiscordThreadId(bad)).toBe(false)
  })
  test('Slack: a C, D or G channel id, alone or with a thread ts', () => {
    for (const ok of ['C0B6KKFNH4N', 'D0B6KKFNH4N', 'C0B6KKFNH4N:1779979488.572029']) expect(isSlackThreadId(ok)).toBe(true)
    for (const bad of [SID, SNOWFLAKE, 'lark', '', 'C0B6KKFNH4N:17799', 'slack:C0B6KKFNH4N:1.2']) expect(isSlackThreadId(bad)).toBe(false)
  })
  test('an id that cannot be a thread is gone without asking the platform', async () => {
    const gw = Object.create(DiscordGateway.prototype) as DiscordGateway
    ;(gw as any).fetchChannel = async () => { throw new Error('asked') }
    expect(await gw.threadExists(SID)).toBe(false)
  })
})

describe('a post to a thread the gateway cannot address', () => {
  test('is dropped, and told once however often it is tried', async () => {
    expect(await safeSend(SID, 'hello')).toEqual([])
    expect(await safeSend(SID, 'again')).toEqual([])
    expect(calls.send).toEqual([])
    expect(log.match(new RegExp(`"${SID}" is not a discord thread`, 'g'))?.length).toBe(1)
  })
  test('a real thread is posted to', async () => {
    expect(await safeSend(SNOWFLAKE, 'hello')).toEqual(['m1'])
    expect(calls.send).toEqual([SNOWFLAKE])
  })
  test('an anchor repaint of it is never queued', () => {
    session({ threadId: SID })
    refreshSessionVisual(SID)
    expect(calls.visual).toEqual([])
    session({ threadId: SNOWFLAKE })
    refreshSessionVisual(SNOWFLAKE)
    expect(calls.visual).toEqual([SNOWFLAKE])
  })
})

describe('a session with no thread of its own is reached through the thread it reports to', () => {
  test('its own thread when it has one', () => {
    expect(routeThreadId(session({ threadId: SNOWFLAKE }))).toBe(SNOWFLAKE)
  })
  test("its parent's when it has none", () => {
    const parent = session({ threadId: SNOWFLAKE })
    expect(routeThreadId(session({ threadId: SID, parentId: parent.sessionId }))).toBe(SNOWFLAKE)
  })
  test('up the chain, and nowhere when the chain has no thread or loops', () => {
    const top = session({ threadId: '1572724151414952030' })
    const mid = session({ threadId: SID2, parentId: top.sessionId })
    expect(routeThreadId(session({ threadId: SID, parentId: mid.sessionId }))).toBe('1572724151414952030')
    const a = session({ threadId: SID, parentId: null })
    expect(routeThreadId(a)).toBeUndefined()
    const b = session({ threadId: SID2 }); const c = session({ threadId: SID, parentId: b.sessionId })
    b.parentId = c.sessionId
    expect(routeThreadId(c)).toBeUndefined()
  })
})

describe('a record already stored with such an id', () => {
  test('is named once at boot, with where its posts go', () => {
    const parent = session({ threadId: SNOWFLAKE })
    session({ threadId: SID, tmuxName: 'lark', parentId: parent.sessionId })
    session({ threadId: SID2, tmuxName: 'moss', parentId: null })
    expect(reportUnaddressableThreads()).toBe(2)
    expect(log).toContain(`session lark stores "${SID}" as its thread, which discord cannot address; its posts go to the thread it reports to (${SNOWFLAKE})`)
    expect(log).toContain('session moss stores')
    expect(log).toContain('its posts are dropped')
    log = ''
    reportUnaddressableThreads()
    expect(log).toBe('')
  })
  test('a record with no thread at all is not reported as one that stores "undefined"', () => {
    session({ threadId: undefined, tmuxName: 'nothread' })
    reportUnaddressableThreads()
    expect(log).not.toContain('nothread')
  })
  test('is not asked the platform about at boot', async () => {
    session({ threadId: SID })
    session({ threadId: SNOWFLAKE })
    await backfillAnchorChannelIds()
    expect(calls.fetchChannel).toEqual([SNOWFLAKE])
    expect(log).toContain(`stores "${SID}" as its thread`)
  })
})
