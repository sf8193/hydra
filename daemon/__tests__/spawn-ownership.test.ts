import { describe, expect, test } from 'bun:test'
import { SpawnOwnership } from '../spawn-ownership.js'

function fixture() {
  const homes = new Set<string>()
  const registry = {
    reservedNames: new Set<string>(),
    reserveCodexHome: (home: string) => {
      if (homes.has(home)) return false
      homes.add(home)
      return true
    },
    releaseCodexHome: (home: string) => { homes.delete(home) },
  }
  return { homes, registry }
}

describe('spawn ownership — L25/L26 and invariant 9', () => {
  test('competing home acquisition releases only the losing name', () => {
    const { registry, homes } = fixture()
    const winner = new SpawnOwnership(registry, 'first', 'codex', 'shared', () => false)
    expect(() => new SpawnOwnership(registry, 'second', 'codex', 'shared', () => false)).toThrow('already active or starting')
    expect([...registry.reservedNames]).toEqual(['first'])
    expect([...homes]).toEqual(['shared'])
    winner.release()
    expect(homes.size).toBe(0)
  })
  test('pending retirement releases both reservations before rejecting', () => {
    const { registry, homes } = fixture()
    expect(() => new SpawnOwnership(registry, 'first', 'codex', 'shared', () => true)).toThrow('unresolved retirement')
    expect(registry.reservedNames.size).toBe(0)
    expect(homes.size).toBe(0)
  })
  test('repeated release cannot erase a successors reservation', () => {
    const { registry, homes } = fixture()
    const first = new SpawnOwnership(registry, 'first', 'codex', 'shared', () => false)
    first.release()
    const successor = new SpawnOwnership(registry, 'first', 'codex', 'shared', () => false)
    first.release()
    expect([...registry.reservedNames]).toEqual(['first'])
    expect([...homes]).toEqual(['shared'])
    successor.release()
  })
})
