import { describe, test, expect, afterEach } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { threadRegistry } from '../../sessions/registry.js'
import { STATE_DIR } from '../../infra/config.js'

const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) { try { cleanups.pop()!() } catch {} } })

describe('the durable history entry a resume reads back', () => {
  const mk = (id: string) => {
    threadRegistry.recordSpawn(id, { sessionId: `${id}-s`, tmuxName: 'x', originType: 'spawn' } as never)
    cleanups.push(() => threadRegistry.delete(id))
    return `${id}-s`
  }
  const entryOf = (id: string) => threadRegistry.get(id)?.sessionHistory.find(h => h.sessionId === `${id}-s`)

  // killSession deletes the registry record, so everything a later resume
  // needs has to be on this entry before it closes.
  test('closing stamps every identity field, including the cost bucket', () => {
    const t = 'T-rk'; mk(t)
    threadRegistry.closeHistoryEntry(t, {
      sessionId: `${t}-s`, messageCount: 7,
      claudeSessionId: 'c-rk', engine: 'codex', codexThreadId: 'cx-1', codexHomeName: 'home-1', label: 'build',
    })
    expect(entryOf(t)).toMatchObject({
      messageCount: 7, claudeSessionId: 'c-rk', engine: 'codex',
      codexThreadId: 'cx-1', codexHomeName: 'home-1', label: 'build',
    })
    expect(entryOf(t)?.endedAt).toBeTruthy()
  })

  test('a close that names no label leaves the one recorded at spawn', () => {
    const t = 'T-keeplabel'
    threadRegistry.recordSpawn(t, {
      topic: 'keep', respawnCount: 0, sessionId: `${t}-s`, tmuxName: 'x', originType: 'spawn', label: 'build',
    })
    cleanups.push(() => threadRegistry.delete(t))
    threadRegistry.closeHistoryEntry(t, { sessionId: `${t}-s`, messageCount: 3, claudeSessionId: 'c-keep' })
    expect(entryOf(t)?.endedAt, 'the entry really did close').toBeTruthy()
    expect(entryOf(t)?.label, 'a crash close must not blank the bucket').toBe('build')
  })

  // A crash closes the entry first; a later kill must not reopen it and reset
  // what the crash recorded.
  test('a second close does not overwrite the first', () => {
    const t = 'T-twice'; mk(t)
    threadRegistry.closeHistoryEntry(t, { sessionId: `${t}-s`, messageCount: 5, claudeSessionId: 'c-first', label: 'review' })
    const closedAt = entryOf(t)!.endedAt
    threadRegistry.closeHistoryEntry(t, { sessionId: `${t}-s`, messageCount: 0, claudeSessionId: 'c-second' })
    expect(entryOf(t)?.endedAt, 'the close time must stand').toBe(closedAt)
    expect(entryOf(t)?.claudeSessionId, 'and so must the recorded id').toBe('c-first')
    expect(entryOf(t)?.messageCount).toBe(5)
    expect(entryOf(t)?.label).toBe('review')
  })

  // closeHistoryEntry persists itself: a crash-closed label must survive a daemon restart.
  test('the closed entry reaches disk, not just the in-memory map', () => {
    const t = 'T-disk'; mk(t)
    threadRegistry.closeHistoryEntry(t, { sessionId: `${t}-s`, messageCount: 3, claudeSessionId: 'c-disk', label: 'investigate' })
    const onDisk = JSON.parse(readFileSync(join(STATE_DIR, 'threads.json'), 'utf8')) as Array<{ threadId: string; sessionHistory: Array<Record<string, unknown>> }>
    const entry = onDisk.find(x => x.threadId === t)?.sessionHistory.find(h => h.sessionId === `${t}-s`)
    expect(entry, 'the thread must be on disk').toBeTruthy()
    expect(entry?.label, 'and the bucket with it').toBe('investigate')
    expect(entry?.claudeSessionId).toBe('c-disk')
  })

  test('a close with the field absent does not blank what spawn recorded', () => {
    const t = 'T-keep'
    threadRegistry.recordSpawn(t, { sessionId: `${t}-s`, tmuxName: 'x', originType: 'fork', claudeSessionId: 'c-from-spawn' } as never)
    cleanups.push(() => threadRegistry.delete(t))
    // the crash path: bridge never connected, so info carries no transcript id
    threadRegistry.closeHistoryEntry(t, { sessionId: `${t}-s`, messageCount: 0 })
    expect(entryOf(t)?.claudeSessionId, 'a later resume needs this').toBe('c-from-spawn')
  })
})
