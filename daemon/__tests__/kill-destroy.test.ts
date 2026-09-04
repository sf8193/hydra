// `kill +d` / `kill +destroy` — kill the session, then delete the thread.
//
// `destroy` on its own refuses while a session is alive ("Kill it first"), so
// the two steps could only ever be issued as two commands with a wait between
// them. The modifier collapses that.
//
// Two things need pinning. First the ordering, since destroy is only reachable
// once the kill has landed. Second the degenerate case: with nothing left to
// kill, the command must still destroy rather than report a failed kill — and
// that arrives in two shapes, a killed session gone from the registry entirely
// and one dead across a daemon restart that is still in it with `deadAt` set.
//
// Each case also asserts what must NOT happen, because the happy outcome is
// reachable by wrong routes: an already-dead session that gets killed anyway
// still ends up destroyed, so these check for the absence of the wasted kill.

import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test'
import { handleThreadKillIntercept } from '../commands/thread.js'
import { registry, threadRegistry } from '../sessions.js'
import type { SessionInfo } from '../sessions.js'
import { gateway } from '../config.js'
import type { InboundMessage } from '../../gateway.js'

const THREAD = 'thread-kd-1'
const PARENT = 'parent-channel-kd'
const ANCHOR = 'anchor-msg-kd'

let deletedThreads: string[] = []
let deletedMessages: Array<{ channelId: string; messageId: string }> = []
let reactions: string[] = []
let sent: string[] = []

let orig: Record<string, unknown> = {}
let origStderr: typeof process.stderr.write

beforeAll(() => {
  orig = {
    deleteThread: gateway.deleteThread,
    delete: gateway.delete,
    react: gateway.react,
    send: gateway.send,
    fetchChannel: gateway.fetchChannel,
    getThreadStarterInfo: gateway.getThreadStarterInfo,
    registryPersist: registry.persist,
    threadPersist: threadRegistry.persist,
  }
  ;(registry as any).persist = () => {}
  ;(threadRegistry as any).persist = () => {}
})

afterAll(() => {
  ;(gateway as any).deleteThread = orig.deleteThread
  ;(gateway as any).delete = orig.delete
  ;(gateway as any).react = orig.react
  ;(gateway as any).send = orig.send
  ;(gateway as any).fetchChannel = orig.fetchChannel
  ;(gateway as any).getThreadStarterInfo = orig.getThreadStarterInfo
  ;(registry as any).persist = orig.registryPersist
  ;(threadRegistry as any).persist = orig.threadPersist
})

beforeEach(() => {
  origStderr = process.stderr.write
  process.stderr.write = (() => true) as any
  deletedThreads = []
  deletedMessages = []
  reactions = []
  sent = []
  ;(gateway as any).deleteThread = async (id: string) => { deletedThreads.push(id) }
  ;(gateway as any).delete = async (channelId: string, messageId: string) => { deletedMessages.push({ channelId, messageId }) }
  ;(gateway as any).react = async (_c: string, _m: string, emoji: string) => { reactions.push(emoji) }
  ;(gateway as any).send = async (_c: string, text: string) => { sent.push(text); return { id: 'm1', channelId: _c } }
  ;(gateway as any).fetchChannel = async () => ({ isThread: true, isDM: false, parentId: PARENT })
  ;(gateway as any).getThreadStarterInfo = async () => ({ starterId: ANCHOR })
})

afterEach(() => {
  for (const id of seeded) registry.delete(id)
  seeded.clear()
  registry.deleteThread(THREAD)
  threadRegistry.threads.delete(THREAD)
  process.stderr.write = origStderr
})

function msg(content: string): InboundMessage {
  return {
    id: 'msg-kd', channelId: THREAD, authorId: 'u1', authorUsername: 'operator',
    content, isDM: false, isThread: true, isBot: false,
    parentChannelId: PARENT, hasExistingThread: false, existingThreadId: null,
    referenceMessageId: null, effectiveThreadId: THREAD, attachments: [], createdAt: new Date(),
  }
}

// One id per case. killSession's in-flight guard is keyed by sessionId and
// clears itself on a timer, so a shared id would let one case's kill suppress
// the next one's and make the file order-dependent.
let seq = 0
const seeded = new Set<string>()

/** A registry entry for the thread, optionally already flagged dead. */
function seedSession(opts: { deadAt?: number; initiator?: string } = {}): SessionInfo {
  const info: SessionInfo = {
    sessionId: `sess-kd-${++seq}`,
    topic: 'topic',
    threadId: THREAD,
    createdAt: Date.now(),
    lastActive: Date.now(),
    tmuxName: 'drift',
    listening: false,
    sessionType: 'thread_owner',
    anchorChannelId: PARENT,
    anchorMessageId: ANCHOR,
    ...(opts.deadAt ? { deadAt: opts.deadAt } : {}),
    ...(opts.initiator ? { initiator: opts.initiator } : {}),
  }
  registry.set(info.sessionId, info)
  registry.setThread(THREAD, info.sessionId)
  seeded.add(info.sessionId)
  return info
}

describe('kill +destroy', () => {
  test('destroys the thread when the session is already gone from the registry', async () => {
    // The post-kill shape: killSession removes the entry outright, so there is
    // no session to resolve. Plain `kill` reacts ❌ here; with the modifier the
    // command still has work to do.
    await handleThreadKillIntercept(msg('kill +d'), { destroy: true })

    expect(deletedThreads).toEqual([THREAD])
    expect(reactions).toContain('💀')
    expect(reactions).not.toContain('❌')
  })

  test('destroys the thread when the session is registered but flagged dead', async () => {
    // The post-restart shape: still in the registry, `deadAt` set. Must not
    // attempt a kill, and must not be refused for being "still alive".
    const info = seedSession({ deadAt: Date.now() })

    await handleThreadKillIntercept(msg('kill +destroy'), { destroy: true })

    expect(deletedThreads).toEqual([THREAD])
    expect(sent.join('\n')).not.toContain('still alive')
    expect(registry.get(info.sessionId)).toBeUndefined()
    // No wasted kill: the ☠️ reaction and the "session ended" post both belong
    // to killSession, and neither should fire for a session already dead.
    expect(reactions).not.toContain('☠️')
    expect(sent.join('\n')).not.toContain('session ended')
  })

  test('deletes the anchor message alongside the thread', async () => {
    seedSession({ deadAt: Date.now() })

    await handleThreadKillIntercept(msg('kill +d'), { destroy: true })

    expect(deletedMessages).toEqual([{ channelId: PARENT, messageId: ANCHOR }])
  })

  test('a live session is killed first, then the thread destroyed', async () => {
    // The ordering that makes the modifier worth having: destroy refuses while a
    // session is alive, so the kill has to land before it runs. Without the
    // trailing destroy step this passes the kill and leaves the thread standing.
    seedSession()

    await handleThreadKillIntercept(msg('kill +d'), { destroy: true })

    expect(reactions).toContain('☠️')          // the kill ran
    expect(deletedThreads).toEqual([THREAD])   // and then the destroy did
    expect(sent.join('\n')).not.toContain('still alive')
    expect(registry.getByThread(THREAD)).toBeUndefined()
  })

  test('a live session with no modifier is killed and the thread kept', async () => {
    seedSession()

    await handleThreadKillIntercept(msg('kill'), {})

    expect(reactions).toContain('☠️')
    expect(deletedThreads).toEqual([])
  })

  test('without the modifier, a vanished session is still just a failed kill', async () => {
    // Guards the existing `kill` contract: only `+destroy` changes this branch.
    await handleThreadKillIntercept(msg('kill'), {})

    expect(reactions).toEqual(['❌'])
    expect(deletedThreads).toEqual([])
  })

  test('a creator-restricted thread is not destroyed by someone else', async () => {
    // destroy re-applies its own guards after the kill; this one survives
    // because the dead entry is still in the registry to carry `initiator`.
    seedSession({ deadAt: Date.now(), initiator: 'someone-else' })

    await handleThreadKillIntercept(msg('kill +d'), { destroy: true })

    expect(deletedThreads).toEqual([])
    expect(sent.join('\n')).toContain('Only the session creator')
  })
})
