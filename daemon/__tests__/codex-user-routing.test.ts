import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

describe('Codex user-message routing ratchet', () => {
  test('both ordinary router delivery sites explicitly choose next-turn mode', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'router.ts'), 'utf8')
    const matches = source.match(/deferUntilTurnComplete:\s*true/g) ?? []
    expect(matches).toHaveLength(2)
  })
})
