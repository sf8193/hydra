// The notice a child's end sends its parent says what happened: `killed` when someone chose the end, `killed & destroyed` when the thread went with it,
// `killed by hydra` when hydra ended it on purpose, `died from crash` when it was lost, `finished` when it ended itself, `handed off` when a successor took the thread, `died` when no one has classified the end. One test per word, each through the real caller; the sites a kill reaches are listed in the PR.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { gateway } from '../../infra/config.js'
import { registry, threadRegistry, type SessionInfo } from '../../sessions/registry.js'
import { executeTool } from '../../app/bridge-dispatch.js'
import { checkSessionDeath } from '../../app/bridge-server.js'
import { finaliseCodexDeath } from '../../app/codex-runtime.js'
import { pollSessionsOnce } from '../../app/session-health.js'
import { killSession } from '../../app/session-lifecycle.js'
import { fakeAdapter } from './test-harness.js'

process.stderr.write = (() => true) as any

const sent: { to: string; text: string }[] = []
const saved = { send: gateway.send, deleteThread: (gateway as any).deleteThread, rp: registry.persist, tp: threadRegistry.persist }
const made: SessionInfo[] = []

function mk(name: string, over: Record<string, unknown> = {}): SessionInfo {
  const info = {
    sessionId: `kv-${name}`, tmuxName: name, topic: 't', description: 't', threadId: `kv-thread-${name}`, createdAt: Date.now() - 60_000, lastActive: Date.now(),
    listening: false, engine: 'claude', sessionType: 'thread_owner', messageCount: 4,
    adapter: fakeAdapter({ isAlive: () => true, usage: () => null, stop: async () => ({ status: 'stopped' }) }), ...over,
  } as unknown as SessionInfo
  registry.set(info.sessionId, info); registry.setThread(info.threadId, info.sessionId); made.push(info)
  return info
}
/** A parent that plain-spawned `kid` (parentId set, no originFrom — #736). */
function family(kid: string, childOver: Record<string, unknown> = {}) {
  const parent = mk('kv-par')
  const child = mk(kid, { originType: 'spawn', parentId: parent.sessionId, initiator: 'kv-par', ...childOver })
  return { parent, child }
}
const toParent = () => sent.filter(m => m.to === 'kv-thread-kv-par').map(m => m.text)

beforeEach(() => {
  sent.length = 0
  ;(gateway as any).send = async (to: string, text: string) => { sent.push({ to, text }); return { id: `m${sent.length}`, channelId: to } }
  ;(gateway as any).deleteThread = async () => {}
  ;(registry as any).persist = () => {}
  ;(threadRegistry as any).persist = () => {}
})
afterEach(() => {
  Object.assign(gateway, { send: saved.send }); (gateway as any).deleteThread = saved.deleteThread
  ;(registry as any).persist = saved.rp; (threadRegistry as any).persist = saved.tp
  for (const s of made.splice(0)) { registry.delete(s.sessionId); registry.deleteThread(s.threadId) }
})

describe('the kill notice to the parent', () => {
  test('a kill says killed', async () => {
    const { parent, child } = family('kv-kid-a')
    await executeTool('kill_session', { session_id: child.sessionId }, parent.sessionId)
    expect(toParent()[0]).toContain('`kv-kid-a` killed — _session ended by kv-par_ (4 msgs)')
  })

  test('a kill that deletes the thread says killed & destroyed', async () => {
    const { parent, child } = family('kv-kid-b')
    await executeTool('kill_session', { session_id: child.sessionId, destroy: true }, 'main')
    expect(toParent()[0]).toContain('`kv-kid-b` killed & destroyed — _session ended_')
  })

  test('an end hydra chose says killed by hydra, and the reason is its cause', async () => {
    const { child } = family('kv-kid-d')
    await killSession(child, 'phase budget expired', { ended: 'killed by hydra' })
    expect(toParent()[0]).toContain('`kv-kid-d` killed by hydra — _phase budget expired_')
  })

  test('a lost session says died from crash', async () => {
    const { child } = family('kv-kid-e')
    await killSession(child, 'bridge was unreachable — respawning', { ended: 'died from crash' })
    expect(toParent()[0]).toContain('`kv-kid-e` died from crash — _bridge was unreachable — respawning_')
  })

  test('a session that ended itself says finished', async () => {
    const { child } = family('kv-kid-f')
    await killSession(child, 'ephemeral [done]', { ended: 'finished' })
    expect(toParent()[0]).toContain('`kv-kid-f` finished — _ephemeral [done]_')
  })

  test('a handoff says handed off, and does not repeat itself as the reason', async () => {
    const { child } = family('kv-kid-g')
    await killSession(child, 'handed off', { ended: 'handed off' })
    expect(toParent()).toEqual([expect.stringMatching(/`kv-kid-g` handed off \(4 msgs\)$/)])
  })

  test('an end nobody has classified still says died', async () => {
    const { child } = family('kv-kid-c')
    await killSession(child, 'idle for 4h')
    expect(toParent()[0]).toContain('`kv-kid-c` died — _idle for 4h_')
  })

  test('crash paths notify a plain-spawned child\'s parent (bridge-server, session-health, codex-runtime)', async () => {
    const { child: bridgeDead } = family('kv-crash-bridge')
    await checkSessionDeath(bridgeDead.sessionId)
    expect(toParent()).toContainEqual(expect.stringContaining('`kv-crash-bridge` died from crash — _tmux dead, bridge disconnected_ (4 msgs)'))
    // A later killSession on the already-dead record (e.g. resume/respawn replacing it) does not send a second notice.
    sent.length = 0
    await killSession(bridgeDead, 'replaced by new spawn', { ended: 'killed by hydra' })
    expect(toParent()).toEqual([])

    sent.length = 0
    const { child: pollDead } = family('kv-crash-poll', {
      adapter: fakeAdapter({ isAlive: () => false, usage: () => null }),
    })
    pollSessionsOnce(Date.now())
    expect(toParent()).toContainEqual(expect.stringContaining('`kv-crash-poll` died from crash — _session died_ (4 msgs)'))

    sent.length = 0
    const { child: codexDead } = family('kv-crash-codex', { engine: 'codex' })
    finaliseCodexDeath(codexDead)
    expect(toParent()).toContainEqual(expect.stringContaining('`kv-crash-codex` died from crash — _app-server unreachable_ (4 msgs)'))
    // Calling finaliseCodexDeath twice does not send a duplicate notice.
    sent.length = 0
    finaliseCodexDeath(codexDead)
    expect(toParent()).toEqual([])
  })

  test('guests, same-thread children, and parentless orphans never send a parent notice', async () => {
    const { parent, child: guest } = family('kv-guest', { sessionType: 'thread_guest' })
    await killSession(guest, 'guest done', { ended: 'finished' })
    expect(toParent()).toEqual([])

    const { child: sameThread } = family('kv-same', { threadId: parent.threadId })
    await killSession(sameThread, 'done', { ended: 'finished' })
    // Only the child's own `_done_` line — no duplicate parent notice.
    expect(toParent()).toEqual(['_done_'])

    sent.length = 0
    const orphan = mk('kv-orphan', { originType: 'spawn', parentId: null })
    await killSession(orphan, 'done', { ended: 'killed' })
    expect(toParent()).toEqual([])
  })
})
