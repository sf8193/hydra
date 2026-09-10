import { beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { join } from 'path'
import { STATE_DIR } from '../config.js'
import {
  completePendingRetirement, hasPendingRetirementForHome,
  listPendingRetirements, recordPendingRetirement,
} from '../retirement-journal.js'

const file = join(STATE_DIR, 'pending-retirements.json')

describe('retirement journal', () => {
  beforeEach(() => { rmSync(file, { force: true }) })

  test('persists unresolved execution identity idempotently', () => {
    const ref = { provider: 'codex' as const, sessionId: 'guest', codexThreadId: 'thread', codexHomeName: 'pixel', ownershipGeneration: 'generation-1' }
    recordPendingRetirement(ref, 'generation-1', 'cancel')
    recordPendingRetirement(ref, 'generation-1', 'cancel again')
    expect(listPendingRetirements()).toHaveLength(1)
    expect(hasPendingRetirementForHome('pixel')).toBe(true)
  })

  test('only removes the matching ownership generation', () => {
    recordPendingRetirement({ provider: 'codex', sessionId: 'old', codexHomeName: 'pixel' }, 'old-generation', 'cancel')
    recordPendingRetirement({ provider: 'codex', sessionId: 'new', codexHomeName: 'other' }, 'new-generation', 'cancel')
    completePendingRetirement('old-generation')
    expect(listPendingRetirements().map(e => e.ownershipGeneration)).toEqual(['new-generation'])
  })
})
