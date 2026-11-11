// A tmux that doesn't answer says nothing about a session: nothing is marked dead or reported stopped on it.
// Every tmux call goes through daemon/tmux.ts's seam, which times out here: no tmux is touched.
import { describe, test, expect, afterEach } from 'bun:test'
import { _setTmuxForTesting, TMUX_HOLD_MS } from '../tmux.js'
import { engines } from '../engines/instances.js'
import { CodexEngineAdapter } from '../engines/codex-engine-adapter.js'
import { ClaudeEngine } from '../engines/claude-engine.js'
import { killSession } from '../session-lifecycle.js'
import { withFakeTmux } from './fake-tmux.js'
import { checkSessionDeath, deathCheckIO } from '../bridge-server.js'
import { registry, threadRegistry } from '../sessions.js'
import type { SessionInfo } from '../sessions.js'

let seq = 0
function session(extra: Partial<SessionInfo> = {}): SessionInfo {
  const n = ++seq
  return { sessionId: `sess-tnr-${n}`, topic: 't', threadId: `thread-tnr-${n}`, createdAt: Date.now(), lastActive: Date.now(), tmuxName: `hydra-tnr-${n}`, listening: false, ...extra } as SessionInfo
}

/** Every tmux call times out; returns the calls made and what was logged. */
function hungTmux() {
  const calls: string[][] = []
  const logged: string[] = []
  _setTmuxForTesting({ exec: ((_f: string, args: string[]) => { calls.push(args); throw Object.assign(new Error('spawnSync tmux ETIMEDOUT'), { code: 'ETIMEDOUT' }) }) as any })
  process.stderr.write = ((l: string) => { logged.push(l); return true }) as any
  return { calls, logged }
}

const write = process.stderr.write
afterEach(() => { _setTmuxForTesting(); process.stderr.write = write })

describe('stop on a tmux that does not answer', () => {
  test('claude: a kill-session that times out is uncertain, with no second probe', async () => {
    const t = hungTmux()
    const info = session({ engine: 'claude', claudeSessionId: 'known' })
    expect(await engines.claude.stop(info)).toEqual({ status: 'uncertain', reason: 'tmux not responding' })
    expect(t.calls).toEqual([['kill-session', '-t', info.tmuxName]])
  })

  test('codex: a kill-session that times out is uncertain, never stopped', async () => {
    hungTmux()
    const adapter = new CodexEngineAdapter({ disconnect: () => {} } as any, { stop: () => true } as any)
    expect(await adapter.stop(session({ engine: 'codex' }))).toEqual({ status: 'uncertain', reason: 'tmux not responding' })
  })
})

describe('the bridge death check on a tmux that does not answer', () => {
  test('does not mark the session dead; one retry is armed, and the episode is logged once', async () => {
    const t = hungTmux()
    const armed: Array<{ fn: () => void; ms: number }> = []
    const later = deathCheckIO.later
    deathCheckIO.later = (fn, ms) => { armed.push({ fn, ms }) }
    const info = session({ engine: 'claude', adapter: engines.claude })
    registry.set(info.sessionId, info)
    try {
      await checkSessionDeath(info.sessionId)
      await checkSessionDeath(info.sessionId)          // a second disconnect while one retry is armed
      expect(registry.get(info.sessionId)!.deadAt).toBeUndefined()
      expect(armed.map(a => a.ms)).toEqual([TMUX_HOLD_MS])
      armed[0]!.fn()                                    // the retry: tmux still silent, so it arms the next
      await Promise.resolve()
      expect(armed).toHaveLength(2)
      expect(t.logged.filter(l => l.includes('death check'))).toEqual([
        `daemon: death check for ${info.tmuxName}: tmux not responding; checking again every ${TMUX_HOLD_MS / 1000}s until it answers\n`,
      ])
    } finally { registry.delete(info.sessionId); deathCheckIO.later = later }
  })

  test('a retry stops once the record is dead or gone: no second verdict, no second crash notice', async () => {
    const t = hungTmux()
    const armed: Array<() => void> = []
    const later = deathCheckIO.later
    deathCheckIO.later = fn => { armed.push(fn) }
    const marked = session({ engine: 'claude', adapter: engines.claude })
    const deleted = session({ engine: 'claude', adapter: engines.claude })
    registry.set(marked.sessionId, marked)
    registry.set(deleted.sessionId, deleted)
    try {
      await checkSessionDeath(marked.sessionId)
      await checkSessionDeath(deleted.sessionId)
      expect(armed).toHaveLength(2)
      marked.deadAt = Date.now()                       // another path gave its verdict while the retry waited
      registry.delete(deleted.sessionId)
      const asked = t.calls.length
      armed[0]!(); armed[1]!()
      await Promise.resolve()
      expect(armed).toHaveLength(2)                    // neither retry arms another
      expect(t.calls).toHaveLength(asked)              // nor asks tmux
    } finally { registry.delete(marked.sessionId); registry.delete(deleted.sessionId); deathCheckIO.later = later }
  })
})

describe('spawn on a tmux that stops answering after new-session', () => {
  test('the session is left unconfirmed, and no pane capture is set up', async () => {
    const fake = withFakeTmux()                     // CLAUDE_CONFIG_DIR in a temp dir, never the real one
    const calls: string[][] = []
    const logged: string[] = []
    _setTmuxForTesting({ exec: ((_f: string, args: string[]) => {
      calls.push(args)
      if (args[0] === 'has-session') throw Object.assign(new Error('spawnSync tmux ETIMEDOUT'), { code: 'ETIMEDOUT' })
      return ''
    }) as any })
    process.stderr.write = ((l: string) => { logged.push(l); return true }) as any
    try {
      await new ClaudeEngine({} as any).launch({ sessionId: 'tnr-s', tmuxName: 'tnr-spawn', cwd: '/tmp', originalCwd: '/tmp', model: 'claude-opus-4-1', prompt: 'hi' } as any)
      expect(logged).toContain('daemon: spawn tnr-spawn: WARNING -- tmux not responding; session unconfirmed, pane capture skipped\n')
      expect(calls.map(c => c[0])).not.toContain('pipe-pane')
    } finally { fake.restore() }
  })
})

describe('kill on a tmux that does not answer', () => {
  test('the uncertain stop is logged, and so is the deferred kill that times out', async () => {
    const t = hungTmux()
    const info = session({ engine: 'claude', adapter: engines.claude, claudeSessionId: 'known', sessionType: 'thread_owner' })
    registry.set(info.sessionId, info)
    threadRegistry.set(info.threadId, { threadId: info.threadId, topic: 't', respawnCount: 0, createdAt: 1, lastActive: 1, totalMessages: 0, sessionHistory: [] } as any)
    try {
      await killSession(info, 'test', { keepRecord: true, skipWorktreeDestroy: true })
      expect(t.logged).toContain(`daemon: stop ${info.tmuxName}: uncertain (tmux not responding); the deferred kill will try again\n`)
      await Bun.sleep(3_300)
      expect(t.logged).toContain(`daemon: deferred kill of "${info.tmuxName}" timed out: tmux not responding; the session may linger\n`)
    } finally { registry.delete(info.sessionId); threadRegistry.delete(info.threadId) }
  }, 10_000)
})
