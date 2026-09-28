import { describe, test, expect, beforeEach } from 'bun:test'
import { decideResume } from '../auto-resume.js'
import { SessionRegistry } from '../sessions.js'

process.stderr.write = (() => true) as any

// ---------------------------------------------------------------------------
// decideResume — pure decision function, every cell in the matrix
// ---------------------------------------------------------------------------

describe('decideResume', () => {
  test('reconnected: transport connected → reconnected (regardless of other state)', () => {
    expect(decideResume(true, true, true, 0)).toBe('reconnected')
    expect(decideResume(true, false, true, 0)).toBe('reconnected')
    expect(decideResume(true, true, false, 2)).toBe('reconnected')
  })

  test('resume: tmux dead + has claude session + under max attempts', () => {
    expect(decideResume(false, true, true, 0)).toBe('resume')
    expect(decideResume(false, true, true, 1)).toBe('resume')
    expect(decideResume(false, true, true, 4)).toBe('resume')
  })

  test('grace: tmux dead but attempts exhausted', () => {
    expect(decideResume(false, true, true, 5)).toBe('grace')
    expect(decideResume(false, true, true, 6)).toBe('grace')
  })

  test('grace: tmux dead but no claude session ID', () => {
    expect(decideResume(false, true, false, 0)).toBe('grace')
  })

  test('grace: tmux alive (bridge flap)', () => {
    expect(decideResume(false, false, true, 0)).toBe('grace')
    expect(decideResume(false, false, false, 0)).toBe('grace')
  })

  test('custom maxAttempts', () => {
    expect(decideResume(false, true, true, 0, 1)).toBe('resume')
    expect(decideResume(false, true, true, 1, 1)).toBe('grace')
  })
})

// ---------------------------------------------------------------------------
// Session map invariant: thread owner mapping survives protocol operations
// ---------------------------------------------------------------------------

describe('session map invariant — thread owner mapping', () => {
  let registry: SessionRegistry

  beforeEach(() => {
    registry = Object.create(SessionRegistry.prototype)
    ;(registry as any).sessions = new Map()
    ;(registry as any).threadToSession = new Map()
    ;(registry as any).threadMembers = new Map()
  })

  function registerOwner(threadId: string, sessionId: string) {
    registry.set(sessionId, {
      sessionId, tmuxName: 'owner', threadId, createdAt: Date.now(), lastActive: Date.now(), listening: true,
    } as any)
    registry.setThread(threadId, sessionId)
  }

  function registerJoinMember(threadId: string, sessionId: string) {
    registry.set(sessionId, {
      sessionId, tmuxName: 'critic', threadId, isJoinMember: true, createdAt: Date.now(), lastActive: Date.now(), listening: false,
    } as any)
    registry.addMember(threadId, sessionId, 'critic')
  }

  test('adding a join member does NOT change thread ownership', () => {
    registerOwner('thread-1', 'owner-1')
    registerJoinMember('thread-1', 'critic-1')
    expect(registry.getByThread('thread-1')).toBe('owner-1')
  })

  test('removing a join member does NOT change thread ownership', () => {
    registerOwner('thread-1', 'owner-1')
    registerJoinMember('thread-1', 'critic-1')
    registry.delete('critic-1')
    registry.removeMember('thread-1', 'critic-1')
    expect(registry.getByThread('thread-1')).toBe('owner-1')
  })

  test('replacing a join member (repeated deaths + resumes) preserves ownership', () => {
    registerOwner('thread-1', 'owner-1')
    registerJoinMember('thread-1', 'critic-1')
    for (const [dead, next] of [['critic-1', 'critic-2'], ['critic-2', 'critic-3']]) {
      registry.delete(dead)
      registry.removeMember('thread-1', dead)
      expect(registry.getByThread('thread-1')).toBe('owner-1')
      registerJoinMember('thread-1', next)
      expect(registry.getByThread('thread-1')).toBe('owner-1')
    }
  })

  test('INVARIANT VIOLATION: setThread with non-owner overwrites ownership', () => {
    registerOwner('thread-1', 'owner-1')
    registry.setThread('thread-1', 'wrong-session')
    expect(registry.getByThread('thread-1')).not.toBe('owner-1')
  })

  test('INVARIANT VIOLATION: deleteThread orphans a live owner', () => {
    registerOwner('thread-1', 'owner-1')
    registry.deleteThread('thread-1')
    expect(registry.getByThread('thread-1')).toBeUndefined()
    expect(registry.get('owner-1')).toBeDefined()
  })
})
