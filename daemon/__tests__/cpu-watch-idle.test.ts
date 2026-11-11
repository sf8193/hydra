// The spin idle check runs on the vitals tick, so it must ask tmux asynchronously. Here the sync tmux
// helpers throw and the async ones answer only after a delay: sampleCpu has to await them, for a
// session with no live signal, a 'working' claim that tmux must confirm, and main.
import { afterAll, expect, mock, test } from 'bun:test'
import type { SessionInfo } from '../sessions.js'

const real = await import('../tmux.js')
let answered = 0
const later = <T>(v: T) => new Promise<T>(r => setTimeout(() => { answered++; r(v) }, 30))
mock.module('../tmux.js', () => ({
  ...real,
  isTmuxRecentlyActiveSync: () => { throw new Error('sync tmux on the vitals tick') },
  tmuxSilentLongerThanSync: () => { throw new Error('sync tmux on the vitals tick') },
  isTmuxRecentlyActive: () => later(false),
  tmuxSilentLongerThan: () => later(true),
}))
const { sampleCpu, _setSpinThresholdForTesting } = await import('../cpu-watch.js')

afterAll(() => _setSpinThresholdForTesting(undefined))

const session = (id: string, turn: object): SessionInfo => ({
  sessionId: id, topic: 't', threadId: `thread-${id}`, createdAt: 0, lastActive: 0,
  tmuxName: `hydra-idle-${id}`, listening: false, engine: 'claude', sessionType: 'thread_owner',
  adapter: { turn: () => turn },
} as unknown as SessionInfo)

test('a hot subject\'s idle check is awaited, never run synchronously', async () => {
  _setSpinThresholdForTesting(0) // every subject reads hot, so every idle check is asked
  const quiet = session('quiet', { live: null })
  const claimed = session('claimed', { live: 'working', workingSilenceLimitS: 600 })
  const sample = await sampleCpu(new Map(), [quiet, claimed], () => ({}), { load1: 1, cores: 10 }, { tmuxName: 'hydra-idle-main' })
  expect(answered).toBe(3)
  expect(sample.sessions.size).toBe(2)
  expect(sample.main).toBeDefined()
})
