import { afterEach, describe, expect, it } from 'bun:test'

import {
  ORPHAN_GRACE_MS,
  _setDaemonStartedAtForTesting,
  blocksRecovery,
  bridgeWaitMs,
  classifyOccupancy,
  daemonPastOrphanGrace,
  occupancy,
  occupied,
} from '../session-reachability.js'
import { engines } from '../engines/instances.js'
import { markDead, registry, threadRegistry, type SessionInfo } from '../sessions.js'
import { transport } from '../bridge-transport.js'
import { withFakeTmux } from './fake-tmux.js'

const old = ORPHAN_GRACE_MS + 1
const fresh = ORPHAN_GRACE_MS - 1

function classify(over: Partial<Parameters<typeof classifyOccupancy>[0]>) {
  return classifyOccupancy({ running: true, connected: true, waitMs: old, ...over })
}

describe('classifyOccupancy', () => {
  it('calls a running session with a connected bridge reachable', () => {
    expect(classify({})).toBe('reachable')
  })

  it('calls a long-running session with no bridge orphaned', () => {
    expect(classify({ connected: false })).toBe('orphaned')
  })

  it('calls a freshly spawned session with no bridge starting, not orphaned', () => {
    expect(classify({ connected: false, waitMs: fresh })).toBe('starting')
  })

  it('treats a connected bridge as reachable however new the session is', () => {
    expect(classify({ waitMs: 0 })).toBe('reachable')
  })

  it('calls a session that is not running and has no bridge dead', () => {
    expect(classify({ running: false, connected: false })).toBe('dead')
  })

  it('a connected bridge is proof enough of a running session', () => {
    expect(classify({ running: false, connected: true })).toBe('reachable')
  })

  it('needs the wait to pass the grace window, not merely reach it', () => {
    expect(classify({ connected: false, waitMs: ORPHAN_GRACE_MS })).toBe('starting')
    expect(classify({ connected: false, waitMs: ORPHAN_GRACE_MS + 1 })).toBe('orphaned')
  })

  it('a session given up on that is still running is orphaned at once, not starting', () => {
    expect(classify({ connected: false, waitMs: 0, givenUp: true })).toBe('orphaned')
  })
})

describe('occupancy of a record', () => {
  let n = 0
  const ids: string[] = []
  afterEach(() => { for (const id of ids.splice(0)) { registry.delete(id); transport.bridges.delete(id) } })

  function rec(over: Partial<SessionInfo> = {}): SessionInfo {
    const sessionId = `occ-${++n}-${Date.now()}`
    const info = {
      sessionId, topic: 't', threadId: `${sessionId}-t`, tmuxName: `occ-tmux-${n}-${Date.now()}`,
      createdAt: Date.now() - ORPHAN_GRACE_MS * 2, lastActive: Date.now(), listening: false,
      engine: 'claude', adapter: engines.claude, sessionType: 'thread_owner', ...over,
    } as SessionInfo
    registry.set(sessionId, info)
    ids.push(sessionId)
    return info
  }

  it('is none without a record', () => {
    expect(occupancy(undefined)).toBe('none')
  })

  it('a record stamped dead whose tmux is still alive is orphaned, not dead', () => {
    const tmux = withFakeTmux()
    try {
      const info = rec({ deadAt: Date.now() })
      tmux.alive(info.tmuxName)
      expect(occupancy(info)).toBe('orphaned')
      expect(occupied(occupancy(info))).toBe(true)
    } finally { tmux.restore() }
  })

  it('a record stamped dead whose tmux is gone is dead', () => {
    const tmux = withFakeTmux()
    try {
      expect(occupancy(rec({ deadAt: Date.now() }))).toBe('dead')
    } finally { tmux.restore() }
  })

  it('a record never stamped dead whose tmux is gone is dead: no spawn grace on a missing execution', () => {
    const tmux = withFakeTmux()
    try {
      expect(occupancy(rec({ createdAt: Date.now() }))).toBe('dead')
    } finally { tmux.restore() }
  })

  it('a connected bridge is reachable even on a record stamped dead', () => {
    const tmux = withFakeTmux()
    try {
      const info = rec({ deadAt: Date.now() })
      tmux.alive(info.tmuxName)
      transport.bridges.set(info.sessionId, {} as any)
      expect(occupancy(info)).toBe('reachable')
    } finally { tmux.restore() }
  })
})

describe('markDead', () => {
  it('writes deadAt and the history entry\'s endedAt together, and keeps the first stamp', () => {
    const origR = registry.persist, origT = threadRegistry.persist
    ;(registry as any).persist = () => {}
    ;(threadRegistry as any).persist = () => {}
    const sessionId = `md-${Date.now()}`, threadId = `${sessionId}-t`
    try {
      const info = { sessionId, threadId, tmuxName: 'md', createdAt: 0, lastActive: 0, topic: 't', listening: false, messageCount: 3 } as SessionInfo
      threadRegistry.recordSpawn(threadId, { topic: 't', respawnCount: 0, sessionId, tmuxName: 'md', originType: 'spawn', label: undefined })
      markDead(info, 1_000)
      markDead(info, 2_000)
      expect(info.deadAt).toBe(1_000)
      const entry = threadRegistry.get(threadId)!.sessionHistory.find(h => h.sessionId === sessionId)!
      expect(entry.endedAt).toBeDefined()
      expect(entry.messageCount).toBe(3)
    } finally {
      threadRegistry.threads.delete(threadId)
      ;(registry as any).persist = origR
      ;(threadRegistry as any).persist = origT
    }
  })
})

describe('blocksRecovery', () => {
  it('refuses recovery for sessions that are fine or still booting', () => {
    expect(blocksRecovery('reachable')).toBe(true)
    expect(blocksRecovery('starting')).toBe(true)
  })

  it('lets recovery proceed for orphaned and dead sessions', () => {
    expect(blocksRecovery('orphaned')).toBe(false)
    expect(blocksRecovery('dead')).toBe(false)
  })
})

describe('daemonPastOrphanGrace', () => {
  it('is false until the daemon has been up longer than the orphan grace window', () => {
    expect(daemonPastOrphanGrace(ORPHAN_GRACE_MS)).toBe(false)
    expect(daemonPastOrphanGrace(ORPHAN_GRACE_MS + 1)).toBe(true)
  })

  it('reads the daemon start clock by default', () => {
    _setDaemonStartedAtForTesting(Date.now())
    expect(daemonPastOrphanGrace()).toBe(false)
    _setDaemonStartedAtForTesting(Date.now() - ORPHAN_GRACE_MS - 1_000)
    expect(daemonPastOrphanGrace()).toBe(true)
    _setDaemonStartedAtForTesting(undefined)
  })
})

describe('bridgeWaitMs', () => {
  afterEach(() => _setDaemonStartedAtForTesting(undefined))

  it('counts from the spawn when the daemon was already running', () => {
    _setDaemonStartedAtForTesting(1_000)
    expect(bridgeWaitMs(5_000, 8_000)).toBe(3_000)
  })

  it('counts from the daemon start when the session is older than the daemon', () => {
    _setDaemonStartedAtForTesting(5_000)
    expect(bridgeWaitMs(1_000, 8_000)).toBe(3_000)
  })
})
