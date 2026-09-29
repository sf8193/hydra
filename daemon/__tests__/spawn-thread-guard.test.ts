// A "spawn opus: <topic>" retry typed directly inside an already-live thread must not
// re-enter that thread's session (doSpawnSession treats a thread-channel chatId as
// "reuse this thread"). Regression for the 97x re-spawn incident: the live-session guard
// in resolveSpawnTarget only checked resolvedThreadId !== msg.channelId, which is never
// true for a message posted inside the thread itself — the one place a stuck-looking
// spawn gets retried from.
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { gateway } from '../config.js'
import { registry } from '../sessions.js'
import { resolveSpawnTarget } from '../commands/global.js'
import type { SessionInfo } from '../sessions.js'
import type { InboundMessage } from '../../gateway.js'

function liveSession(id: string, threadId: string, anchorChannelId: string): SessionInfo {
  const info = {
    sessionId: id, topic: 't', threadId, createdAt: Date.now(), lastActive: Date.now(),
    tmuxName: id, listening: false, engine: 'claude', sessionType: 'thread_owner',
    adapter: { provider: 'claude', isAlive: () => true },
    anchorChannelId,
  } as unknown as SessionInfo
  registry.set(id, info)
  registry.setThread(threadId, id)
  return info
}

function threadMsg(threadId: string): InboundMessage {
  return {
    channelId: threadId, isThread: true, effectiveThreadId: threadId,
    id: 'msg1', authorUsername: 'sam', isDM: false,
  } as InboundMessage
}

describe('resolveSpawnTarget: retrying a spawn inside an already-live thread', () => {
  let sends: any[]
  beforeEach(() => { sends = []; spyOn(gateway, 'send').mockImplementation((async (...a: any[]) => { sends.push(a); return { id: 'm1' } }) as any) })
  afterEach(() => { registry.delete('spawn-guard-live'); registry.deleteThread('spawn-guard-thread') })

  test('does not return the live thread itself as the spawn target', async () => {
    liveSession('spawn-guard-live', 'spawn-guard-thread', 'parent-channel-1')

    const chatId = await resolveSpawnTarget(threadMsg('spawn-guard-thread'))

    expect(chatId).not.toBe('spawn-guard-thread')
    expect(chatId).toBe('parent-channel-1')
    expect(sends.some(a => String(a[1]).includes('already has a live session'))).toBe(true)
  })
})
