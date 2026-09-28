import { describe, expect, test } from 'bun:test'
import { isSessionWorking, isSessionWorkingAsync } from '../session-activity.js'
import { engines } from '../engines/instances.js'
import { CLAUDE_WORKING_SILENCE_S } from '../engines/claude-engine.js'
import { CODEX_WORKING_STALE_MS, defaultTurnSources, isCodexWorking, noteCodexTurnState } from '../engines/codex-observation.js'
import { liveStateOf } from '../engines/claude-status.js'
import { fakeAdapter } from './test-harness.js'
import { codexHomeDir } from '../codex-process.js'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { withFakeTmux } from './fake-tmux.js'
import type { SessionInfo } from '../sessions.js'
import type { LiveState } from '../engines/engine-adapter.js'

const withLive = (live: LiveState | null, extra: Partial<SessionInfo> = {}) =>
  ({ sessionId: 's1', tmuxName: 'cedar', adapter: fakeAdapter({ turn: () => ({ live, activityAt: null, confirmedComplete: false, answer: () => null }) }), ...extra }) as unknown as SessionInfo

describe('isSessionWorking', () => {
  test('the provider signal decides when it has one; tmux is not consulted', async () => {
    const fake = withFakeTmux()
    try {
      fake.activity('cedar', Math.floor(Date.now() / 1000)) // pane looks active
      expect(isSessionWorking(withLive('working'))).toBe(true)
      for (const live of ['idle', 'blocked'] as const) {
        expect(isSessionWorking(withLive(live))).toBe(false)
        expect(await isSessionWorkingAsync(withLive(live))).toBe(false)
      }
      expect(fake.calls().filter(c => c.startsWith('display'))).toEqual([])
    } finally { fake.restore() }
  })
  test('unknown provider signal falls back to tmux activity in the last 60s', async () => {
    const fake = withFakeTmux()
    try {
      const now = Math.floor(Date.now() / 1000)
      fake.activity('cedar', now - 10)
      expect(isSessionWorking(withLive(null))).toBe(true)
      expect(await isSessionWorkingAsync(withLive(null))).toBe(true)
      fake.activity('cedar', now - 120)
      expect(isSessionWorking(withLive(null))).toBe(false)
      expect(await isSessionWorkingAsync(withLive(null))).toBe(false)
    } finally { fake.restore() }
  })
  test('a working claim from an engine with a silence limit holds only while the pane was active within it (hung busy)', async () => {
    const fake = withFakeTmux()
    try {
      const now = Math.floor(Date.now() / 1000)
      const limited = () => ({ sessionId: 's1', tmuxName: 'cedar', adapter: fakeAdapter({ turn: () => ({ live: 'working', workingSilenceLimitS: 600, activityAt: null, confirmedComplete: false, answer: () => null }) }) }) as unknown as SessionInfo
      fake.activity('cedar', now - 300) // 5 min ago: inside the limit (and outside the 60s fallback window)
      expect(isSessionWorking(limited())).toBe(true)
      expect(await isSessionWorkingAsync(limited())).toBe(true)
      fake.activity('cedar', now - 700) // silent past the limit: a hung busy
      expect(isSessionWorking(limited())).toBe(false)
      expect(await isSessionWorkingAsync(limited())).toBe(false)
      // tmux cannot answer (no such window / error): unknown is not silence, the claim stands
      const gone = () => ({ sessionId: 's1', tmuxName: 'no-such-window', adapter: fakeAdapter({ turn: () => ({ live: 'working', workingSilenceLimitS: 600, activityAt: null, confirmedComplete: false, answer: () => null }) }) }) as unknown as SessionInfo
      expect(isSessionWorking(gone())).toBe(true)
      expect(await isSessionWorkingAsync(gone())).toBe(true)
      // no limit advertised (Codex): the claim stands whatever the pane says
      expect(isSessionWorking(withLive('working'))).toBe(true)
      expect(await isSessionWorkingAsync(withLive('working'))).toBe(true)
    } finally { fake.restore() }
  })
  test('no adapter, or an adapter that throws, is unknown (tmux fallback), never an exception', () => {
    const fake = withFakeTmux()
    try {
      fake.activity('cedar', Math.floor(Date.now() / 1000))
      expect(isSessionWorking({ sessionId: 's1', tmuxName: 'cedar' } as SessionInfo)).toBe(true) // no adapter: tmux says active
      const boom = { sessionId: 's1', tmuxName: 'cedar', adapter: fakeAdapter({ turn: () => { throw new Error('x') } }) } as unknown as SessionInfo
      expect(isSessionWorking(boom)).toBe(true)
    } finally { fake.restore() }
  })
})

describe('adapter live state', () => {
  test('liveStateOf: busy/idle/waiting map; anything else is unknown', () => {
    expect(['busy', 'shell', 'idle', 'waiting', 'weird', ''].map(liveStateOf)).toEqual(['working', 'working', 'idle', 'blocked', null, null])
  })
  test('claude: read from the status file, null when unreadable, lazily', () => {
    const fake = withFakeTmux(); fake.activity('cedar', Math.floor(Date.now() / 1000))
    const saved = { ...defaultTurnSources }
    let reads = 0
    let status: { sessionId: string; status: string } | null = { sessionId: 'c', status: 'busy' }
    Object.assign(defaultTurnSources, { readClaudeStatus: (n: string) => { reads++; return n === 'cedar' ? status : null } })
    try {
      const info = { sessionId: 's1', tmuxName: 'cedar' } as SessionInfo
      const t = engines.claude.turn(info, 0)
      expect(reads).toBe(0)
      expect(t.live).toBe('working')
      status = { sessionId: 'c', status: 'waiting' }
      expect(engines.claude.turn(info, 0).live).toBe('blocked')
      status = null
      expect(engines.claude.turn(info, 0).live).toBeNull()
      status = { sessionId: 'c', status: 'shell' } // a Bash tool is running
      expect(engines.claude.turn(info, 0).live).toBe('working')
    } finally { Object.assign(defaultTurnSources, saved); fake.restore() }
  })
  test('claude: live reports working from the status file alone; the engine advertises the silence limit', () => {
    const fake = withFakeTmux()
    const saved = { ...defaultTurnSources }
    Object.assign(defaultTurnSources, { readClaudeStatus: (n: string) => n === 'cedar' ? { sessionId: 'c', status: 'busy' } : null })
    try {
      fake.activity('cedar', Math.floor(Date.now() / 1000) - CLAUDE_WORKING_SILENCE_S - 60) // pane silent past the limit
      const t = engines.claude.turn({ sessionId: 's1', tmuxName: 'cedar' } as SessionInfo, 0)
      expect(t.live).toBe('working') // no tmux in the adapter: isSessionWorking bounds it
      expect(t.workingSilenceLimitS).toBe(CLAUDE_WORKING_SILENCE_S)
      expect(fake.calls().filter(c => c.startsWith('display'))).toEqual([])
    } finally { Object.assign(defaultTurnSources, saved); fake.restore() }
  })
  test('claude: live shares the outcome snapshot with confirmedComplete (one status read per turn object)', () => {
    const fake = withFakeTmux(); fake.activity('cedar', Math.floor(Date.now() / 1000))
    const saved = { ...defaultTurnSources }
    let reads = 0
    Object.assign(defaultTurnSources, { readClaudeStatus: () => { reads++; return { sessionId: 'c', status: 'busy' } } })
    try {
      const t = engines.claude.turn({ sessionId: 's1', tmuxName: 'cedar' } as SessionInfo, 0)
      expect([t.live, t.confirmedComplete, t.live]).toEqual(['working', false, 'working'])
      expect(reads).toBe(1)
    } finally { Object.assign(defaultTurnSources, saved); fake.restore() }
  })
})
