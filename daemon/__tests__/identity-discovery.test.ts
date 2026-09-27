// Pins Claude native-id discovery at kill (G1) and fork (G2): a Claude record
// with no claudeSessionId learns it from the running pane; a Codex record (or a
// Claude→Codex fork) never asks tmux for the pane at all.
//
// Runs the real discoverClaudeSessionId through a PATH-shim tmux and a temp
// CLAUDE_CONFIG_DIR (see fake-tmux.ts).

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { killSession } from '../session-lifecycle.js'
import { handleForkIntercept } from '../commands/thread.js'
import { registry, threadRegistry } from '../sessions.js'
import type { SessionInfo } from '../sessions.js'
import { gateway } from '../config.js'
import { CodexEngineAdapter } from '../engines/codex-engine-adapter.js'
import type { InboundMessage } from '../../gateway.js'
import { withFakeTmux, type FakeTmux } from './fake-tmux.js'

const SID = '11111111-2222-4333-8444-555555555555'
const PID = '424242'

let tmux: FakeTmux
let sent: string[] = []
let stderr: string[] = []
let registryPersists = 0
let seq = 0
const seededSessions = new Set<string>()
const seededThreads = new Set<string>()
let orig: Record<string, any> = {}

beforeAll(() => {
  orig = {
    send: gateway.send, react: gateway.react, edit: gateway.edit,
    registryPersist: registry.persist, threadPersist: threadRegistry.persist,
  }
  ;(registry as any).persist = () => { registryPersists++ }
  ;(threadRegistry as any).persist = () => {}
})

afterAll(() => {
  ;(gateway as any).send = orig.send
  ;(gateway as any).react = orig.react
  ;(gateway as any).edit = orig.edit
  ;(registry as any).persist = orig.registryPersist
  ;(threadRegistry as any).persist = orig.threadPersist
})

beforeEach(() => {
  tmux = withFakeTmux()
  sent = []; stderr = []; registryPersists = 0
  ;(gateway as any).send = async (_c: string, text: string) => { sent.push(text); return { id: 'm1' } }
  ;(gateway as any).react = async () => {}
  ;(gateway as any).edit = async () => {}
  orig.stderrWrite = process.stderr.write
  process.stderr.write = ((s: string) => { stderr.push(String(s)); return true }) as any
})

afterEach(() => {
  process.stderr.write = orig.stderrWrite
  tmux.restore()
  for (const id of seededSessions) registry.delete(id)
  for (const t of seededThreads) { registry.deleteThread(t); threadRegistry.threads.delete(t) }
  seededSessions.clear(); seededThreads.clear()
})

function seed(engine: 'claude' | 'codex', extra: Partial<SessionInfo> = {}): SessionInfo {
  const n = ++seq
  const info: SessionInfo = {
    sessionId: `sess-idd-${n}`,
    topic: 'topic',
    threadId: `thread-idd-${n}`,
    createdAt: Date.now(),
    lastActive: Date.now(),
    tmuxName: `hydra-t3-idd-${n}`,
    listening: false,
    engine,
    sessionType: 'thread_owner',
    ...extra,
  }
  registry.set(info.sessionId, info)
  seededSessions.add(info.sessionId)
  seededThreads.add(info.threadId)
  threadRegistry.recordSpawn(info.threadId, {
    topic: 'topic', respawnCount: 0, sessionId: info.sessionId, tmuxName: info.tmuxName,
    originType: 'spawn', label: undefined,
  })
  // Discovery would succeed for this pane if anyone asked.
  tmux.pid(info.tmuxName, PID)
  tmux.seedClaudeSession(PID, SID)
  return info
}

const listPanes = () => tmux.calls().filter(c => c.startsWith('list-panes'))

function fakeCodexAdapter(): CodexEngineAdapter {
  return new CodexEngineAdapter({ disconnect() {}, isConnected: () => true } as any, { stop() {} } as any)
}

describe('G1: killSession discovers a missing Claude id', () => {
  test('Claude record without an id: discovered, logged, and carried into the closed history entry', async () => {
    const info = seed('claude')
    await killSession(info, 'session ended')

    expect(listPanes()).toEqual([`list-panes -t ${info.tmuxName} -F #{pane_pid}`])
    expect(info.claudeSessionId).toBe(SID)
    expect(stderr.join('')).toContain(`daemon: kill ${info.tmuxName}: late-discovered claudeSessionId=${SID}`)
    const entry = threadRegistry.get(info.threadId)!.sessionHistory.find(h => h.sessionId === info.sessionId)!
    expect(entry.endedAt).toBeDefined()
    expect(entry.claudeSessionId).toBe(SID)
  })

  test('Claude record that already has an id: no discovery', async () => {
    const info = seed('claude', { claudeSessionId: 'already-known' })
    await killSession(info, 'session ended')

    expect(listPanes()).toEqual([])
    expect(info.claudeSessionId).toBe('already-known')
  })

  test('Codex record: discovery is never attempted', async () => {
    const info = seed('codex', { adapter: fakeCodexAdapter() })
    await killSession(info, 'session ended')

    expect(listPanes()).toEqual([])
    expect(info.claudeSessionId).toBeUndefined()
    expect(stderr.join('')).not.toContain('late-discovered')
  })
})

describe('G2: handleForkIntercept discovers only for Claude→Claude', () => {
  function forkMsg(info: SessionInfo): InboundMessage {
    registry.setThread(info.threadId, info.sessionId)
    return {
      id: 'msg-idd', channelId: info.threadId, authorId: 'u1', authorUsername: 'operator',
      content: 'fork', isDM: false, isThread: true, isBot: false,
      parentChannelId: 'parent-idd', hasExistingThread: false, existingThreadId: null,
      referenceMessageId: null, effectiveThreadId: info.threadId, attachments: [], createdAt: new Date(),
    }
  }

  // The pane is not "alive" to the shim, so each fork stops at "Cannot fork"
  // right after the discovery step — nothing is spawned.
  test('Claude→Claude: discovers the id and persists it', async () => {
    const info = seed('claude')
    await handleForkIntercept(forkMsg(info), undefined, undefined, { engine: 'claude' })

    expect(listPanes()).toEqual([`list-panes -t ${info.tmuxName} -F #{pane_pid}`])
    expect(info.claudeSessionId).toBe(SID)
    expect(registryPersists).toBe(1)
    expect(sent.some(t => t.includes('Cannot fork'))).toBe(true)
  })

  test('Claude→Claude (engine defaulted from the source): discovers', async () => {
    const info = seed('claude')
    await handleForkIntercept(forkMsg(info))

    expect(info.claudeSessionId).toBe(SID)
  })

  test('Claude→Codex: no discovery', async () => {
    const info = seed('claude')
    await handleForkIntercept(forkMsg(info), undefined, undefined, { engine: 'codex' })

    expect(listPanes()).toEqual([])
    expect(info.claudeSessionId).toBeUndefined()
    expect(registryPersists).toBe(0)
    expect(sent.some(t => t.includes('Cannot fork'))).toBe(true)
  })
})
