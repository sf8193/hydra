// The daemon's sync tmux: one owner, killed at its timeout, and a hold after one. Every call goes through the
// seam, so no tmux is touched.
import { describe, test, expect, afterEach, spyOn } from 'bun:test'
import { execFileSync } from 'child_process'
import { hasFreeze, tmuxCreateSession, tmuxHasSession, tmuxSessionState, tmuxServerState, tmuxSync, tmuxWindowActivity, _setTmuxForTesting, TMUX_TIMEOUT_MS, TMUX_HOLD_MS } from '../tmux.js'

describe('tmuxSync and the hold', () => {
  afterEach(() => _setTmuxForTesting())
  const timeout = () => { throw Object.assign(new Error('spawnSync tmux ETIMEDOUT'), { code: 'ETIMEDOUT' }) }
  const missing = () => { throw Object.assign(new Error("can't find session"), { status: 1 }) }
  /** Logs what tmuxSync writes, and runs each tmux call through `answer` on a clock the test moves. */
  function fake(answer: (args: string[]) => string) {
    const calls: string[][] = []
    const logged: string[] = []
    const clock = { now: 0 }
    _setTmuxForTesting({ exec: ((_f: string, args: string[]) => { calls.push(args); return answer(args) }) as any, now: () => clock.now })
    const write = process.stderr.write
    process.stderr.write = ((l: string) => { logged.push(l); return true }) as any
    return { calls, logged, clock, done: () => { process.stderr.write = write } }
  }

  test('a hung has-session is killed at the timeout and reads as alive', () => {
    // A real hang, on a stand-in command that honours the call's own options: no tmux is touched.
    _setTmuxForTesting({ exec: ((_f: string, _a: string[], opts: object) => execFileSync('sleep', ['30'], opts)) as any })
    const started = performance.now()
    expect(tmuxSessionState('hung')).toBe('not responding')
    expect(tmuxHasSession('hung')).toBe(true)
    expect(performance.now() - started).toBeLessThan(TMUX_TIMEOUT_MS + 1_000)
  })

  test('a session tmux says is missing is dead', () => {
    const f = fake(missing)
    try { expect(tmuxSessionState('gone')).toBe('dead'); expect(tmuxHasSession('gone')).toBe(false) } finally { f.done() }
  })

  test('after a timeout, reads are not asked for TMUX_HOLD_MS; an act still is; the hold is logged once, and its end', () => {
    let hung = true
    const f = fake(args => { if (hung) timeout(); return args[0] === 'list-sessions' ? 'main\n' : '' })
    try {
      expect(tmuxSessionState('a')).toBe('not responding')
      f.clock.now = TMUX_HOLD_MS - 1
      expect(tmuxSessionState('b')).toBe('not responding')
      expect(tmuxServerState()).toBe('not responding')
      expect(() => tmuxWindowActivity('c')).toThrow('not asked')
      expect(() => tmuxSync(['show-options', '-g'])).toThrow('not asked')   // anything not listed as an act waits
      expect(f.calls).toEqual([['has-session', '-t', '=a']])
      expect(() => tmuxSync(['kill-session', '-t', 'd'])).toThrow()   // acts are still tried
      expect(f.calls).toHaveLength(2)
      hung = false
      f.clock.now += TMUX_HOLD_MS
      expect(tmuxServerState()).toBe('running')
    } finally { f.done() }
    expect(f.logged).toEqual([
      `daemon: tmux has-session timed out at ${TMUX_TIMEOUT_MS}ms; tmux reads not asked for ${TMUX_HOLD_MS / 1000}s (sessions read as alive)\n`,
      'daemon: tmux is answering again\n',
    ])
  })

  test('ignoreHold asks anyway: the server has just answered another call', () => {
    let hung = true
    const f = fake(() => { if (hung) timeout(); return '' })
    try {
      tmuxSessionState('a')
      hung = false
      expect(tmuxSessionState('b', { ignoreHold: true })).toBe('alive')
    } finally { f.done() }
  })

  test('a send-keys timeout (a call given longer than a read) does not start the hold', () => {
    let hung = true
    const f = fake(args => { if (hung && args[0] === 'send-keys') timeout(); return '' })
    try {
      expect(() => tmuxSync(['send-keys', '-t', 'a', 'Enter'], { timeout: 3_000 })).toThrow()
      hung = false
      expect(tmuxSessionState('a')).toBe('alive')
      expect(f.calls.map(c => c[0])).toEqual(['send-keys', 'has-session'])
    } finally { f.done() }
    expect(f.logged).toEqual([])
  })

  test('"answering again" needs a real answer: an exit status, not a tmux that could not be run', () => {
    const notInstalled = () => { throw Object.assign(new Error('spawnSync tmux ENOENT'), { code: 'ENOENT' }) }
    let answer: () => string = timeout
    const f = fake(() => answer())
    try {
      expect(tmuxSessionState('a')).toBe('not responding')
      f.clock.now = TMUX_HOLD_MS
      answer = notInstalled
      expect(tmuxSessionState('a')).toBe('not responding')   // a tmux that never ran says nothing about the session
      expect(tmuxServerState()).toBe('not responding')
      expect(f.logged).toHaveLength(1)
      answer = missing
      expect(tmuxSessionState('a')).toBe('dead')
      expect(f.logged.at(-1)).toBe('daemon: tmux is answering again\n')
    } finally { f.done() }
  })

  // The fake clock reads this; tmux says #{session_created} in epoch seconds.
  const NOW_S = 1_800_000_000

  test('create: on success, the state tmux reports just after, asked past the hold', () => {
    const f = fake(() => '')
    try {
      expect(tmuxCreateSession('made', ['sleep 60'])).toBe('alive')
      expect(f.calls.map(c => c[0])).toEqual(['set-environment', 'new-session', 'has-session'])
      expect(f.calls[2]).toEqual(['has-session', '-t', '=made'])
    } finally { f.done() }
  })

  test('create: a new-session killed at its bound whose session tmux made since the call began is created', () => {
    const f = fake(args => { if (args[0] === 'new-session') timeout(); return args[0] === 'display-message' ? `${NOW_S}\n` : '' })
    f.clock.now = NOW_S * 1000
    try {
      expect(tmuxCreateSession('made', ['sleep 60'])).toBe('alive')
      expect(f.calls.at(-1)).toEqual(['display-message', '-p', '-t', '=made:', '#{session_created}'])
    } finally { f.done() }
  })

  test('create: a session already under the name (made before the call) is not adopted: it is killed, exactly, and the timeout thrown', () => {
    const f = fake(args => { if (args[0] === 'new-session') timeout(); return args[0] === 'display-message' ? `${NOW_S - 600}\n` : '' })
    f.clock.now = NOW_S * 1000
    try {
      expect(() => tmuxCreateSession('stale', ['sleep 60'])).toThrow('ETIMEDOUT')
      expect(f.calls.slice(-2)).toEqual([['display-message', '-p', '-t', '=stale:', '#{session_created}'], ['kill-session', '-t', '=stale']])
    } finally { f.done() }
  })

  test('create: one tmux cannot date is torn down, and the timeout thrown', () => {
    const f = fake(args => { if (args[0] === 'new-session') timeout(); if (args[0] === 'display-message') missing(); return '' })
    try {
      expect(() => tmuxCreateSession('lost', ['sleep 60'])).toThrow('ETIMEDOUT')
      expect(f.calls.map(c => c[0])).toEqual(['set-environment', 'new-session', 'display-message', 'kill-session'])
    } finally { f.done() }
  })

  test('hydra health: a server that times out is not responding; one that fails is not running', () => {
    let f = fake(timeout)
    try { expect(tmuxServerState()).toBe('not responding') } finally { f.done() }
    f = fake(missing)
    try { expect(tmuxServerState()).toBe('not running') } finally { f.done() }
  })
})

describe('hasFreeze', () => {
  afterEach(() => _setTmuxForTesting())
  test('looks freeze up on PATH once, with no spawn, and keeps the answer', () => {
    _setTmuxForTesting()
    const which = spyOn(Bun, 'which')
    try {
      const found = hasFreeze()
      expect(found).toBe(Bun.which('freeze') !== null)
      expect(hasFreeze()).toBe(found)
      expect(which).toHaveBeenCalledTimes(2)      // once by hasFreeze, once by this test
    } finally { which.mockRestore() }
  })
})
