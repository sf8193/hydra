import { describe, test, expect } from 'bun:test'
import { formatThreadName } from '../../discord-gateway.js'

const base = {
  state: 'live' as const,
  emoji: '🔣',
  sessionName: 'glyph',
  description: 'fixing auth middleware',
}

describe('formatThreadName', () => {
  test('live session, no protocol, no respawn', () => {
    const { name, priority } = formatThreadName(base)
    expect(name).toBe('🔣 fixing auth middleware · glyph')
    expect(priority).toBe('normal')
  })

  test('live session with respawn count', () => {
    const { name } = formatThreadName({ ...base, respawnCount: 2 })
    expect(name).toBe('🔣 fixing auth middleware · glyph²')
  })

  test('live session with high respawn count', () => {
    const { name } = formatThreadName({ ...base, respawnCount: 9 })
    expect(name).toBe('🔣 fixing auth middleware · glyph⁹')
  })

  test('respawn count above 9 shows 9+', () => {
    const { name } = formatThreadName({ ...base, respawnCount: 10 })
    expect(name).toBe('🔣 fixing auth middleware · glyph⁹⁺')
  })

  test('respawn count of 1 shows no suffix', () => {
    const { name } = formatThreadName({ ...base, respawnCount: 1 })
    expect(name).toBe('🔣 fixing auth middleware · glyph')
  })

  test('live session with review badge (top of round — critic)', () => {
    const { name, priority } = formatThreadName({ ...base, badge: '⚔️²▲₃' })
    expect(name).toBe('🔣 ⚔️²▲₃ fixing auth middleware · glyph')
    expect(priority).toBe('normal')
  })

  test('live session with review badge (bottom of round — owner)', () => {
    const { name } = formatThreadName({ ...base, badge: '⚔️²▼₃' })
    expect(name).toBe('🔣 ⚔️²▼₃ fixing auth middleware · glyph')
  })

  test('live session with build badge and respawn', () => {
    const { name } = formatThreadName({ ...base, badge: '🔨¹▲₄', respawnCount: 3 })
    expect(name).toBe('🔣 🔨¹▲₄ fixing auth middleware · glyph³')
  })

  test('killed session — high priority, skull prefix', () => {
    const { name, priority } = formatThreadName({ ...base, state: 'killed' })
    expect(name).toBe('› ☠️ fixing auth middleware · glyph')
    expect(priority).toBe('high')
  })

  test('crashed session', () => {
    const { name, priority } = formatThreadName({ ...base, state: 'crashed' })
    expect(name).toBe('› 💥 fixing auth middleware · glyph')
    expect(priority).toBe('high')
  })

  test('paused session — high priority, receding prefix', () => {
    const { name, priority } = formatThreadName({ ...base, paused: true })
    expect(name).toBe('› ⏸ fixing auth middleware · glyph')
    expect(priority).toBe('high')
  })

  test('dead overrides paused', () => {
    const { name } = formatThreadName({ ...base, state: 'killed', paused: true })
    expect(name).toBe('› ☠️ fixing auth middleware · glyph')
  })

  test('dead drops protocol badge', () => {
    const { name } = formatThreadName({ ...base, state: 'crashed', badge: '⚔️²▲₃' })
    expect(name).toBe('› 💥 fixing auth middleware · glyph')
  })

  test('paused drops protocol badge', () => {
    const { name } = formatThreadName({ ...base, paused: true, badge: '⚔️²▼₃' })
    expect(name).toBe('› ⏸ fixing auth middleware · glyph')
  })

  test('falls back to topic when no description', () => {
    const { name } = formatThreadName({ ...base, description: undefined, topic: 'BitBot PR review' })
    expect(name).toBe('🔣 BitBot PR review · glyph')
  })

  test('falls back to session name when no description or topic', () => {
    const { name } = formatThreadName({ ...base, description: undefined, topic: undefined })
    expect(name).toBe('🔣 glyph · glyph')
  })

  test('strips markdown from description', () => {
    const { name } = formatThreadName({ ...base, description: '**bold** and *italic*' })
    expect(name).toBe('🔣 bold and italic · glyph')
  })

  test('truncates to 100 chars', () => {
    const longDesc = 'a'.repeat(200)
    const { name } = formatThreadName({ ...base, description: longDesc })
    expect(name.length).toBeLessThanOrEqual(100)
  })

  test('killed with respawn count', () => {
    const { name } = formatThreadName({ ...base, state: 'killed', respawnCount: 2 })
    expect(name).toBe('› ☠️ fixing auth middleware · glyph²')
  })
})
