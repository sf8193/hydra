import { handleHandoffIntercept } from '../commands/thread.js'
import { handoffIO } from '../session-lifecycle.js'
import { registry, type SessionInfo, type SpawnOpts } from '../sessions.js'
import { transport } from '../bridge-transport.js'
import { gateway } from '../config.js'

/** A live session in its own thread, with everything a handoff touches outside the daemon stubbed. */
export type HandoffThread = {
  info: SessionInfo
  /** What the session was sent (transport.sendOrQueue). */
  delivered: any[]
  /** What was posted to the thread (gateway.send). */
  sent: string[]
  /** Successor spawns (handoffIO.doSpawnSession); the kill just drops the record. */
  spawned: SpawnOpts[]
  /** Types `handoff` in this thread (handleHandoffIntercept). */
  intercept: (msg?: Record<string, unknown>, selection?: { model: string; engine: any }, note?: string) => Promise<void>
  restore: () => void
}

let seq = 0

/** Registers a bare live thread-owner session. */
export const mkSession = (id: string, name: string, threadId: string) => registry.set(id, {
  sessionId: id, tmuxName: name, topic: 't', threadId, createdAt: Date.now(), lastActive: Date.now(),
  listening: false, engine: 'claude', adapter: { stop: async () => {} }, sessionType: 'thread_owner',
} as any)

/** Sets up a HandoffThread; call restore() when done. For beforeEach/afterEach; tests use withHandoffThread. */
export function openHandoffThread(name = 'pulse'): HandoffThread {
  const n = ++seq
  const sessionId = `hot-${n}`, threadId = `hot-thread-${n}`
  mkSession(sessionId, name, threadId)
  registry.setThread(threadId, sessionId)
  const orig = { ...handoffIO, sendOrQueue: transport.sendOrQueue, react: gateway.react, send: gateway.send }
  const delivered: any[] = [], sent: string[] = [], spawned: SpawnOpts[] = []
  ;(transport as any).sendOrQueue = (_id: string, m: any) => { delivered.push(m) }
  ;(gateway as any).react = async () => {}
  ;(gateway as any).send = async (_c: string, text: string) => { sent.push(text); return { id: 'm' } }
  handoffIO.killSession = (async (i: SessionInfo) => { registry.delete(i.sessionId) }) as any
  handoffIO.doSpawnSession = (async (_t: string, _c?: string, _m?: string, o?: SpawnOpts) => {
    spawned.push(o!)
    return { name: 'fresh', sessionId: `${sessionId}-next`, threadId, url: '' }
  }) as any
  return {
    info: registry.get(sessionId)!,
    delivered, sent, spawned,
    intercept: (msg = {}, selection, note) =>
      handleHandoffIntercept({ channelId: threadId, id: 'm', isThread: true, content: 'handoff', ...msg } as any, selection, note),
    restore: () => {
      handoffIO.killSession = orig.killSession; handoffIO.doSpawnSession = orig.doSpawnSession
      ;(transport as any).sendOrQueue = orig.sendOrQueue
      ;(gateway as any).react = orig.react
      ;(gateway as any).send = orig.send
      registry.delete(sessionId); registry.deleteThread(threadId)
    },
  }
}

/** Runs fn against a fresh HandoffThread, restoring every stub and removing the session afterwards. */
export async function withHandoffThread<T>(fn: (t: HandoffThread) => Promise<T>, name?: string): Promise<T> {
  const t = openHandoffThread(name)
  try { return await fn(t) } finally { t.restore() }
}

/** Polls instead of a fixed sleep: CI load stretches the handoff's 500ms answer-first delay. */
export async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms
  while (!cond() && Date.now() < until) await Bun.sleep(20)
}
