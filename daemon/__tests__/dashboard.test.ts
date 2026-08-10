import { describe, test, expect } from 'bun:test'
import { groupSessions } from '../dashboard.js'
import type { WatchEntry } from '../pr-watch.js'

function makeRow(name: string, overrides: {
  originFrom?: string
  isFactoryBuilder?: boolean
  originType?: string
} = {}) {
  return {
    name,
    sessionId: `sid-${name}`,
    emoji: '🌿',
    desc: `${name} description`,
    age: '1m',
    connected: true,
    paused: false,
    url: '',
    watches: [] as WatchEntry[],
    contextLinks: [] as string[],
    artifacts: [] as string[],
    ...overrides,
  }
}

describe('groupSessions', () => {
  test('flat list with no relationships returns all as roots', () => {
    const sessions = [makeRow('alpha'), makeRow('beta'), makeRow('gamma')]
    const grouped = groupSessions(sessions)
    expect(grouped).toHaveLength(3)
    expect(grouped.every(g => g.depth === 0)).toBe(true)
  })

  test('child with originFrom matching an active session is nested under its parent', () => {
    const sessions = [
      makeRow('comet'),
      makeRow('fern', { originFrom: 'comet', isFactoryBuilder: true }),
    ]
    const grouped = groupSessions(sessions)
    expect(grouped).toHaveLength(2)
    expect(grouped[0].session.name).toBe('comet')
    expect(grouped[0].depth).toBe(0)
    expect(grouped[1].session.name).toBe('fern')
    expect(grouped[1].depth).toBe(1)
  })

  test('child ordering: parent first, then children in order', () => {
    const sessions = [
      makeRow('pm'),
      makeRow('builder-a', { originFrom: 'pm' }),
      makeRow('builder-b', { originFrom: 'pm' }),
    ]
    const grouped = groupSessions(sessions)
    expect(grouped).toHaveLength(3)
    expect(grouped[0].session.name).toBe('pm')
    expect(grouped[1].session.name).toBe('builder-a')
    expect(grouped[2].session.name).toBe('builder-b')
    expect(grouped[2].isLastChild).toBe(true)
    expect(grouped[1].isLastChild).toBe(false)
  })

  test('orphaned child (originFrom not in active set) becomes a root', () => {
    const sessions = [
      makeRow('fern', { originFrom: 'comet' }), // comet not in list
    ]
    const grouped = groupSessions(sessions)
    expect(grouped).toHaveLength(1)
    expect(grouped[0].depth).toBe(0)
    expect(grouped[0].session.name).toBe('fern')
  })

  test('multiple root groups are interleaved correctly', () => {
    const sessions = [
      makeRow('pm1'),
      makeRow('child1a', { originFrom: 'pm1' }),
      makeRow('child1b', { originFrom: 'pm1' }),
      makeRow('pm2'),
      makeRow('child2a', { originFrom: 'pm2' }),
    ]
    const grouped = groupSessions(sessions)
    expect(grouped).toHaveLength(5)
    // pm1 group
    expect(grouped[0].session.name).toBe('pm1')
    expect(grouped[0].depth).toBe(0)
    expect(grouped[1].session.name).toBe('child1a')
    expect(grouped[1].depth).toBe(1)
    expect(grouped[2].session.name).toBe('child1b')
    expect(grouped[2].depth).toBe(1)
    // pm2 group
    expect(grouped[3].session.name).toBe('pm2')
    expect(grouped[3].depth).toBe(0)
    expect(grouped[4].session.name).toBe('child2a')
    expect(grouped[4].depth).toBe(1)
  })

  test('empty input returns empty output', () => {
    expect(groupSessions([])).toEqual([])
  })

  test('deeply nested (grandchild) also groups recursively', () => {
    const sessions = [
      makeRow('root'),
      makeRow('child', { originFrom: 'root' }),
      makeRow('grandchild', { originFrom: 'child' }),
    ]
    const grouped = groupSessions(sessions)
    expect(grouped).toHaveLength(3)
    expect(grouped[0].depth).toBe(0) // root
    expect(grouped[1].depth).toBe(1) // child
    expect(grouped[2].depth).toBe(2) // grandchild
  })
})
