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
  })

  test('grace: tmux dead but attempts exhausted', () => {
    expect(decideResume(false, true, true, 20)).toBe('grace')
    expect(decideResume(false, true, true, 25)).toBe('grace')
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

  test('replacing a join member preserves ownership', () => {
    registerOwner('thread-1', 'owner-1')
    registerJoinMember('thread-1', 'critic-1')
    registry.delete('critic-1')
    registry.removeMember('thread-1', 'critic-1')
    registerJoinMember('thread-1', 'critic-2')
    expect(registry.getByThread('thread-1')).toBe('owner-1')
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

// ---------------------------------------------------------------------------
// Full auto-resume lifecycle with real registry state
// ---------------------------------------------------------------------------

describe('auto-resume lifecycle', () => {
  let registry: SessionRegistry

  beforeEach(() => {
    registry = Object.create(SessionRegistry.prototype)
    ;(registry as any).sessions = new Map()
    ;(registry as any).threadToSession = new Map()
    ;(registry as any).threadMembers = new Map()
  })

  test('two critic deaths + auto-resumes preserve thread ownership', () => {
    const threadId = 'thread-review'
    const ownerId = 'glyph-session'

    registry.set(ownerId, { sessionId: ownerId, tmuxName: 'glyph', threadId, createdAt: Date.now(), lastActive: Date.now(), listening: true } as any)
    registry.setThread(threadId, ownerId)

    for (const criticId of ['critic-v1', 'critic-v2']) {
      registry.set(criticId, { sessionId: criticId, tmuxName: 'scout', threadId, isJoinMember: true, createdAt: Date.now(), lastActive: Date.now() } as any)
      registry.addMember(threadId, criticId, 'critic')
      expect(registry.getByThread(threadId)).toBe(ownerId)

      registry.delete(criticId)
      registry.removeMember(threadId, criticId)
      expect(registry.getByThread(threadId)).toBe(ownerId)
    }
  })

  test('BUG REPRO: tryResume without joinThread breaks then orphans', () => {
    const threadId = 'thread-review'
    const ownerId = 'glyph-session'

    registry.set(ownerId, { sessionId: ownerId, tmuxName: 'glyph', threadId, createdAt: Date.now(), lastActive: Date.now(), listening: true } as any)
    registry.setThread(threadId, ownerId)
    registry.set('critic-1', { sessionId: 'critic-1', tmuxName: 'scout', threadId, isJoinMember: true, createdAt: Date.now(), lastActive: Date.now() } as any)
    registry.addMember(threadId, 'critic-1', 'critic')

    // Bug path: setThread overwrites, deleteThread orphans
    registry.setThread(threadId, 'critic-2')
    expect(registry.getByThread(threadId)).not.toBe(ownerId)
    registry.deleteThread(threadId)
    expect(registry.getByThread(threadId)).toBeUndefined()
    expect(registry.get(ownerId)).toBeDefined()
  })
})
