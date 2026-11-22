import { describe, test, expect } from 'bun:test'
import { SessionRegistry, ThreadRegistry, type SessionInfo, type ThreadSessionEntry } from '../../sessions/registry.js'
import { recoveryEngine } from '../../engines/history.js'

const threadsIn = (): ThreadRegistry => {
  const threads = new ThreadRegistry()
  const t = threads as unknown as { persist: () => void; threadsFile: string; writes: number }
  t.writes = 0
  t.persist = () => { t.writes++ }
  t.threadsFile = '/nonexistent/threads.json'
  return threads
}
const sessionOf = (sessionId: string, threadId: string, extra: Partial<SessionInfo>): SessionInfo =>
  ({ sessionId, tmuxName: sessionId, topic: 't', threadId, createdAt: 1, lastActive: 1, sessionType: 'thread_owner', ...extra }) as SessionInfo

describe('the engine a history entry carries', () => {
  test('recordSpawn writes it, so a session killed or dead across a restart resumes on its own engine', () => {
    for (const engine of ['claude', 'codex', 'agy', 'omp'] as const) {
      const threads = threadsIn()
      threads.recordSpawn(`th-${engine}`, { topic: 't', respawnCount: 0, sessionId: `s-${engine}`, tmuxName: engine, originType: 'spawn', label: undefined, engine })
      // The daemon restarts and the session's record is gone (a kill deletes it): only the history entry is left to say what ran.
      threads.boot({ values: () => [][Symbol.iterator]() } as unknown as SessionRegistry)
      const entry = threads.get(`th-${engine}`)!.sessionHistory[0]
      expect(entry.engine).toBe(engine)
      expect(recoveryEngine(entry, undefined)).toBe(engine)
    }
  })

  test('an entry from before it was recorded is given one at load, once, and written back', () => {
    const threads = threadsIn()
    const old = (sessionId: string, extra: Partial<ThreadSessionEntry> = {}) =>
      ({ sessionId, tmuxName: sessionId, originType: 'spawn', startedAt: 1, endedAt: 2, messageCount: 0, ...extra }) as ThreadSessionEntry
    ;(threads as unknown as { threads: Map<string, unknown> }).threads.set('th-old', {
      threadId: 'th-old', topic: 't', respawnCount: 0, createdAt: 1, lastActive: 1, totalMessages: 0, parentChannelId: 'p',
      sessionHistory: [
        old('o-rec', { model: 'claude-opus-5-5' }),                // its record says agy: the record outranks the model
        old('o-agy', { model: 'gemini-3-pro' }),                   // no record: the model names the engine
        old('o-gpt', { model: 'gpt-5.1' }),                        // Codex, with no thread id
        old('o-codex-id', { codexThreadId: 'cx' }),                // no model: the id
        old('o-plain'),                                            // no evidence: Claude
        old('o-kept', { engine: 'omp' }),                          // already recorded: untouched
      ],
    })
    const before = (threads as unknown as { writes: number }).writes
    threads.boot({ values: () => [sessionOf('o-rec', 'th-elsewhere', { engine: 'agy' })][Symbol.iterator]() } as unknown as SessionRegistry)
    expect(threads.get('th-old')!.sessionHistory.map(h => h.engine)).toEqual(['agy', 'agy', 'codex', 'codex', 'claude', 'omp'])
    expect((threads as unknown as { writes: number }).writes, 'the migration is written back').toBeGreaterThan(before)
  })

  test('a session found dead at boot closes its entry with its engine and Codex ids, so a later kill leaves it whole', () => {
    const threads = threadsIn()
    threads.recordSpawn('th-dead', { topic: 't', respawnCount: 0, sessionId: 's-dead', tmuxName: 'dead', originType: 'spawn', label: undefined, engine: 'codex' })
    threads.boot({ values: () => [sessionOf('s-dead', 'th-dead', { engine: 'codex', deadAt: 9, codexThreadId: 'cx-9', codexHomeName: 'home-9' })][Symbol.iterator]() } as unknown as SessionRegistry)
    expect(threads.get('th-dead')!.sessionHistory[0]).toMatchObject({ endedAt: 9, engine: 'codex', codexThreadId: 'cx-9', codexHomeName: 'home-9' })
  })

  test('recordSpawn writes the Codex ids the launch returned', () => {
    const threads = threadsIn()
    threads.recordSpawn('th-cx', { topic: 't', respawnCount: 0, sessionId: 's-cx', tmuxName: 'cx', originType: 'spawn', label: undefined, engine: 'codex', codexThreadId: 'cx-1', codexHomeName: 'h-1' })
    expect(threads.get('th-cx')!.sessionHistory[0]).toMatchObject({ engine: 'codex', codexThreadId: 'cx-1', codexHomeName: 'h-1' })
  })

  test('an entry boot makes from a live record carries that record\'s engine', () => {
    const threads = threadsIn()
    threads.boot({ values: () => [sessionOf('b-omp', 'th-b', { engine: 'omp' })][Symbol.iterator]() } as unknown as SessionRegistry)
    expect(threads.get('th-b')!.sessionHistory[0].engine).toBe('omp')
  })
})
