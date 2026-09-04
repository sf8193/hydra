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
    status.setTrackedListMsgs([{ channelId: 'c1', messageId: 'm1' }])

    await status.refreshListDisplay()

    expect(editAttempts).toEqual(['m1'])
    expect(status.trackedListMsgs()).toHaveLength(1)
  })

  test('a rate-limit does not retire the display', async () => {
    status.setTrackedListMsgs([{ channelId: 'c1', messageId: 'm1' }])
    editImpl = async () => { throw Object.assign(new Error('rate limited'), { code: 429 }) }

    await status.refreshListDisplay()

    // Forgetting it here is permanent — the display would never refresh again.
    expect(status.trackedListMsgs()).toHaveLength(1)
  })

  test('an over-length rejection does not retire the display', async () => {
    // What made this reachable: enough live sessions that the render exceeds
    // the platform limit, which a deep link per row (non-empty on Discord as
    // of this PR) roughly halves. safeEdit's own truncation is covered in
    // util.test.ts — reaching it through here would need a live tmux session
    // per row, since isAlive gates what the list renders. This asserts the
    // part that is status.ts's to get right: the rejection must not be read
    // as "the message is gone".
    status.setTrackedListMsgs([{ channelId: 'c1', messageId: 'm1' }])
    editImpl = async () => { throw Object.assign(new Error('Invalid Form Body'), { code: 50035 }) }

    await status.refreshListDisplay()

    expect(status.trackedListMsgs()).toHaveLength(1)
  })

  test('a deleted message is the one case worth forgetting', async () => {
    status.setTrackedListMsgs([{ channelId: 'c1', messageId: 'm1' }])
    editImpl = async () => { throw Object.assign(new Error('Unknown Message'), { code: 10008 }) }

    await status.refreshListDisplay()

    expect(status.trackedListMsgs()).toHaveLength(0)
  })

  test('one dead message does not take the others with it', async () => {
    status.setTrackedListMsgs([
      { channelId: 'c1', messageId: 'm1' },
      { channelId: 'c1', messageId: 'm2' },
      { channelId: 'c1', messageId: 'm3' },
    ])
    editImpl = async (_c, m) => {
      if (m === 'm2') throw Object.assign(new Error('Unknown Message'), { code: 10008 })
      return m
    }

    await status.refreshListDisplay()

    expect(editAttempts.sort()).toEqual(['m1', 'm2', 'm3'])
    expect(status.trackedListMsgs().map(m => m.messageId)).toEqual(['m1', 'm3'])
  })
})
