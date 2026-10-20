// The auto-refreshing /list display — what happens to a tracked message when
// its edit fails.
//
// The invariant under test: the display is persisted, so forgetting a message
// is permanent. Only a message that is really gone may be forgotten; a
// rate-limit or a dropped connection must leave it tracked.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { __test as statusTest } from '../commands/status.js'
import { registry } from '../sessions.js'
import type { SessionInfo } from '../sessions.js'
import { gateway } from '../config.js'
import { fakeAdapter } from './test-harness.js'

if (!statusTest) throw new Error('status.__test only available under NODE_ENV=test')
const status = statusTest

let origStderrWrite: typeof process.stderr.write
let origEdit: typeof gateway.edit
let origFetchMessages: typeof gateway.fetchMessages
let origRegistryPersist: typeof registry.persist

let editAttempts: string[] = []
let editImpl: (channelId: string, messageId: string, text: string) => Promise<string>

const trackedSessions = new Set<string>()

beforeEach(() => {
  origStderrWrite = process.stderr.write
  process.stderr.write = (() => true) as any
  origRegistryPersist = registry.persist
  ;(registry as any).persist = () => {}

  editAttempts = []
  editImpl = async (_c, m) => m
  origEdit = gateway.edit
  origFetchMessages = gateway.fetchMessages
  ;(gateway as any).edit = async (channelId: string, messageId: string, text: string) => {
    editAttempts.push(messageId)
    return editImpl(channelId, messageId, text)
  }
  // The display enriches each row with its thread's latest message; not the
  // subject here, so keep it empty.
  ;(gateway as any).fetchMessages = async () => []

  status.setPersist(() => {})

  // One session on record, so the render has something to walk.
  const info: SessionInfo = {
    sessionId: 'list-sess-drift',
    topic: 'a reasonably wordy topic',
    threadId: 'list-thread-drift',
    createdAt: Date.now(),
    lastActive: Date.now(),
    tmuxName: 'drift',
    listening: false,
    engine: 'claude',
    // A fake, not the real singleton: this file only needs formatSessionEntry
    // to render *something*.
    adapter: fakeAdapter({ usage: () => null }),
    sessionType: 'thread_owner',
  }
  registry.set(info.sessionId, info)
  trackedSessions.add(info.sessionId)
})

afterEach(() => {
  status.setTrackedListMsgs([])
  status.resetPersist()
  for (const sid of trackedSessions) registry.delete(sid)
  trackedSessions.clear()
  ;(gateway as any).edit = origEdit
  ;(gateway as any).fetchMessages = origFetchMessages
  ;(registry as any).persist = origRegistryPersist
  process.stderr.write = origStderrWrite
})

describe('auto-refreshing /list display', () => {
  test('a successful edit keeps the message tracked', async () => {
    status.setTrackedListMsgs([{ channelId: 'c1', messageIds: ['m1'] }])

    await status.refreshListDisplay()

    expect(editAttempts).toEqual(['m1'])
    expect(status.trackedListMsgs()).toHaveLength(1)
  })

  test('a rate-limit or over-length rejection does not retire the display', async () => {
    // Over-length became reachable with enough live sessions that the render
    // exceeds the platform limit, which a deep link per row (non-empty on
    // Discord) roughly halves. safeEdit's own truncation is covered in
    // util.test.ts — reaching it through here would need a live tmux session
    // per row, since isAlive gates what the list renders. This asserts the
    // part that is status.ts's to get right: neither rejection may be read as
    // "the message is gone". Forgetting it is permanent — the display would
    // never refresh again.
    for (const [message, code] of [['rate limited', 429], ['Invalid Form Body', 50035]] as const) {
      status.setTrackedListMsgs([{ channelId: 'c1', messageIds: ['m1'] }])
      editImpl = async () => { throw Object.assign(new Error(message), { code }) }

      await status.refreshListDisplay()

      expect(status.trackedListMsgs(), `code ${code}`).toHaveLength(1)
    }
  })

  test('a deleted message is the one case worth forgetting', async () => {
    status.setTrackedListMsgs([{ channelId: 'c1', messageIds: ['m1'] }])
    editImpl = async () => { throw Object.assign(new Error('Unknown Message'), { code: 10008 }) }

    await status.refreshListDisplay()

    expect(status.trackedListMsgs()).toHaveLength(0)
  })

  test('one dead message does not take the others with it', async () => {
    status.setTrackedListMsgs([
      { channelId: 'c1', messageIds: ['m1'] },
      { channelId: 'c1', messageIds: ['m2'] },
      { channelId: 'c1', messageIds: ['m3'] },
    ])
    editImpl = async (_c, m) => {
      if (m === 'm2') throw Object.assign(new Error('Unknown Message'), { code: 10008 })
      return m
    }

    await status.refreshListDisplay()

    expect(editAttempts.sort()).toEqual(['m1', 'm2', 'm3'])
    expect(status.trackedListMsgs().map(m => m.messageIds[0])).toEqual(['m1', 'm3'])
  })

  test('every chunk of a long list is rewritten, not just the first', async () => {
    for (let n = 0; n < 60; n++) {
      const sid = `list-sess-many-${n}`
      registry.set(sid, {
        sessionId: sid, topic: 'topic', threadId: `list-thread-many-${n}`,
        createdAt: Date.now(), lastActive: Date.now(), tmuxName: `many${n}`, description: `session description number ${n}`,
        listening: false, engine: 'claude', adapter: fakeAdapter({ usage: () => null, isAlive: () => true }),
        sessionType: 'thread_owner',
      } as SessionInfo)
      trackedSessions.add(sid)
    }
    const texts = new Map<string, string>()
    editImpl = async (_c, m) => m
    ;(gateway as any).edit = async (_c: string, m: string, text: string) => { texts.set(m, text); return m }
    const sent: string[] = []
    const origSend = gateway.send
    ;(gateway as any).send = async (_c: string, text: string) => { sent.push(text); return { id: `new${sent.length}` } }
    status.setTrackedListMsgs([{ channelId: 'c1', messageIds: ['a', 'b'] }])

    await status.refreshListDisplay()
    ;(gateway as any).send = origSend

    const [lm] = status.trackedListMsgs()
    const all = [...lm.messageIds.map(id => texts.get(id) ?? sent[Number(id.slice(3)) - 1])].join('\n')
    expect(lm.messageIds.length).toBeGreaterThan(2)
    expect(all).not.toContain('truncated')
    for (let n = 0; n < 60; n++) expect(all).toContain(`many${n}`)
  })

  test('two overlapping refreshes of a growing list send each new chunk once', async () => {
    for (let n = 0; n < 60; n++) {
      const sid = `list-sess-race-${n}`
      registry.set(sid, {
        sessionId: sid, topic: 'topic', threadId: `list-thread-race-${n}`,
        createdAt: Date.now(), lastActive: Date.now(), tmuxName: `race${n}`, description: `session description number ${n}`,
        listening: false, engine: 'claude', adapter: fakeAdapter({ usage: () => null, isAlive: () => true }),
        sessionType: 'thread_owner',
      } as SessionInfo)
      trackedSessions.add(sid)
    }
    let sends = 0
    const origSend = gateway.send
    ;(gateway as any).send = async () => { await Promise.resolve(); return { id: `new${++sends}` } }
    status.setTrackedListMsgs([{ channelId: 'c1', messageIds: ['a'] }])
    await status.refreshListDisplay()
    const expected = sends
    sends = 0
    status.setTrackedListMsgs([{ channelId: 'c1', messageIds: ['a'] }])

    await Promise.all([status.refreshListDisplay(), status.refreshListDisplay()])
    ;(gateway as any).send = origSend

    expect(expected).toBeGreaterThan(0)
    expect(sends).toBe(expected)
  })

  test('a leftover chunk whose delete is rate-limited stays tracked until it is deleted', async () => {
    let deleteFails = true
    const origDelete = gateway.delete
    ;(gateway as any).delete = async () => { if (deleteFails) throw Object.assign(new Error('rate limited'), { code: 429 }) }
    status.setTrackedListMsgs([{ channelId: 'c1', messageIds: ['a', 'b', 'c'] }])

    await status.refreshListDisplay()
    expect(status.trackedListMsgs()[0].messageIds).toEqual(['a', 'b', 'c'])

    deleteFails = false
    await status.refreshListDisplay()
    ;(gateway as any).delete = origDelete
    expect(status.trackedListMsgs()[0].messageIds).toEqual(['a'])
  })
})
