import { describe, test, expect } from 'bun:test'
import { executeTool } from '../bridge-dispatch.js'
import { registry } from '../sessions.js'

// Suppress stderr
process.stderr.write = (() => true) as any

test('dispatcher rejects a phase-scoped tool after capability removal', async () => {
  const sessionId = 'scope-enforcement-session'
  registry.set(sessionId, {
    sessionId, tmuxName: 'scope-enforcement', topic: '', threadId: 'scope-thread',
    createdAt: Date.now(), lastActive: Date.now(), listening: false,
    engine: 'claude', sessionType: 'thread_owner',
  } as any)
  try {
    const result = await executeTool('kill_session', { session_id: 'anything' }, sessionId)
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('not available to this session')
  } finally {
    registry.delete(sessionId)
  }
})

test('Codex non-PM session is denied protocol spawn tools', async () => {
  const sessionId = 'codex-non-pm'
  registry.set(sessionId, {
    sessionId, tmuxName: 'codex-non-pm', topic: '', threadId: 'codex-thread',
    createdAt: Date.now(), lastActive: Date.now(), listening: false,
    engine: 'codex', sessionType: 'thread_guest',
  } as any)
  try {
    const result = await executeTool('kill_session', { session_id: 'anything' }, sessionId)
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('not available to this session')
  } finally {
    registry.delete(sessionId)
  }
})

test('protocol PM cannot kill the builder it did not spawn', async () => {
  const pmId = 'protocol-pm-kill-scope'
  const builderId = 'protocol-builder-kill-scope'
  registry.set(pmId, {
    sessionId: pmId, tmuxName: 'protocol-pm', topic: '', threadId: 'scope-thread',
    createdAt: Date.now(), lastActive: Date.now(), listening: false,
    engine: 'codex', sessionType: 'thread_owner', capabilities: ['protocol_spawn'],
  } as any)
  registry.set(builderId, {
    sessionId: builderId, tmuxName: 'protocol-builder', topic: '', threadId: 'scope-thread',
    createdAt: Date.now(), lastActive: Date.now(), listening: false,
    engine: 'claude', sessionType: 'thread_guest', originFrom: 'daemon',
  } as any)
  try {
    const result = await executeTool('kill_session', { session_id: builderId }, pmId)
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('you can only kill sessions you spawned')
  } finally {
    registry.delete(pmId)
    registry.delete(builderId)
  }
})

describe('send_to_thread', () => {
  test('rejects missing target', async () => {
    const result = await executeTool('send_to_thread', { type: 'progress', text: 'hello' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('target is required')
  })

  test('rejects empty target', async () => {
    const result = await executeTool('send_to_thread', { target: '  ', type: 'progress', text: 'hello' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('target is required')
  })

  test('rejects missing type', async () => {
    const result = await executeTool('send_to_thread', { target: 'cedar', text: 'hello' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('type is required')
  })

  test('rejects invalid type', async () => {
    const result = await executeTool('send_to_thread', { target: 'cedar', type: 'info', text: 'hello' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('type is required: progress, question, result')
  })

  test('rejects missing text', async () => {
    const result = await executeTool('send_to_thread', { target: 'cedar', type: 'progress' })
    expect(result.isError).toBe(true)
  })

  test('rejects unknown session name with helpful error', async () => {
    const result = await executeTool('send_to_thread', { target: 'nonexistent-xyz', type: 'result', text: 'hello' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('no session named "nonexistent-xyz"')
    expect(result.content[0].text).toContain('Known sessions')
  })

  test('rejects bad file attachment', async () => {
    const testId = `file-test-${Date.now()}`
    registry.set(testId, {
      sessionId: testId,
      topic: 'test',
      threadId: 'thread-file',
      createdAt: Date.now(),
      lastActive: Date.now(),
      tmuxName: 'file-test-session',
      listening: false,
      engine: 'claude', sessionType: 'thread_owner' as const,
    })
    try {
      const result = await executeTool('send_to_thread', { target: 'file-test-session', type: 'progress', text: 'hello', files: ['/nonexistent'] })
      expect(result.isError).toBe(true)
    } finally {
      registry.delete(testId)
    }
  })

  test('resolves session name to threadId', async () => {
    const testId = `orch-test-${Date.now()}`
    registry.set(testId, {
      sessionId: testId,
      topic: 'test',
      threadId: 'resolved-thread-123',
      createdAt: Date.now(),
      lastActive: Date.now(),
      tmuxName: 'orch-test-session',
      listening: false,
      engine: 'claude', sessionType: 'thread_owner' as const,
    })
    try {
      const result = await executeTool('send_to_thread', { target: 'orch-test-session', type: 'result', text: 'done' })
      if (result.isError) {
        expect(result.content[0].text).not.toContain('target is required')
        expect(result.content[0].text).not.toContain('type is required')
        expect(result.content[0].text).not.toContain('no session named')
      }
    } finally {
      registry.delete(testId)
    }
  })

  test('accepts all three valid types', async () => {
    for (const type of ['progress', 'question', 'result']) {
      const result = await executeTool('send_to_thread', { target: 'nonexistent', type, text: 'test' })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('no session named')
    }
  })
})

describe('peek_session', () => {
  test('rejects missing name', async () => {
    const result = await executeTool('peek_session', {})
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('name is required')
  })

  test('rejects empty name', async () => {
    const result = await executeTool('peek_session', { name: '  ' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('name is required')
  })

  test('rejects unknown session', async () => {
    const result = await executeTool('peek_session', { name: 'nonexistent-session-xyz' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('no session named')
  })

  test('denies sibling peek (parent-child restriction)', async () => {
    const childId = `child-${Date.now()}`
    const siblingId = `sibling-${Date.now()}`
    registry.set(childId, {
      sessionId: childId, topic: 'child task', threadId: 'thread-child',
      createdAt: Date.now(), lastActive: Date.now(),
      tmuxName: 'peek-child', listening: false,
      engine: 'claude', sessionType: 'thread_owner' as const,
      originFrom: 'peek-parent', originType: 'spawn',
    })
    registry.set(siblingId, {
      sessionId: siblingId, topic: 'sibling task', threadId: 'thread-sibling',
      createdAt: Date.now(), lastActive: Date.now(),
      tmuxName: 'peek-sibling', listening: false,
      engine: 'claude', sessionType: 'thread_owner' as const,
      originFrom: 'peek-parent', originType: 'spawn',
    })
    try {
      const result = await executeTool('peek_session', { name: 'peek-child' }, siblingId)
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('peek denied')
    } finally {
      registry.delete(childId)
      registry.delete(siblingId)
    }
  })

  test('allows main to peek any session', async () => {
    const testId = `peek-main-${Date.now()}`
    registry.set(testId, {
      sessionId: testId, topic: 'test', threadId: 'thread-peek-main',
      createdAt: Date.now(), lastActive: Date.now(),
      tmuxName: 'peek-main-target', listening: false,
      engine: 'claude', sessionType: 'thread_owner' as const,
      originFrom: 'some-other-parent',
    })
    try {
      const result = await executeTool('peek_session', { name: 'peek-main-target' }, 'main')
      const text = result.content[0].text
      expect(text).not.toContain('peek denied')
    } finally {
      registry.delete(testId)
    }
  })

  test('clamps lines to valid range', async () => {
    const testId = `peek-test-${Date.now()}`
    registry.set(testId, {
      sessionId: testId, topic: 'test', threadId: 'thread-peek',
      createdAt: Date.now(), lastActive: Date.now(),
      tmuxName: 'peek-test-session', listening: false,
      engine: 'claude', sessionType: 'thread_owner' as const,
    })
    try {
      const result = await executeTool('peek_session', { name: 'peek-test-session', lines: 9999 })
      const text = result.content[0].text
      expect(text).not.toContain('invalid')
      expect(text).not.toContain('out of range')
    } finally {
      registry.delete(testId)
    }
  })
})

describe('list_sessions', () => {
  test('returns array (accessible to non-main callers)', async () => {
    const result = await executeTool('list_sessions', {}, 'some-worker-session')
    expect(result.isError).toBeUndefined()
    const parsed = JSON.parse(result.content[0].text)
    expect(Array.isArray(parsed)).toBe(true)
  })

  test('includes lineage fields in output format', async () => {
    // list_sessions filters by isAlive (requires tmux), so we check live sessions
    const result = await executeTool('list_sessions', {})
    const parsed = JSON.parse(result.content[0].text) as any[]
    // Every entry should have the lineage fields
    for (const entry of parsed) {
      expect(entry).toHaveProperty('origin_type')
      expect(entry).toHaveProperty('origin_from')
      expect(entry).toHaveProperty('thread_id')
    }
  })
})

describe('download_attachment', () => {
  test('a message with nothing downloadable reports that, without a path', async () => {
    const { gateway } = await import('../config.js')
    const real = gateway.downloadAttachments
    gateway.downloadAttachments = (async () => []) as typeof gateway.downloadAttachments
    try {
      const result = await executeTool('download_attachment', { chat_id: 'D0BE3RB4Y00', message_id: '1789403254.473939' })
      expect(result.isError).toBeFalsy()
      expect(result.content[0].text).toContain('1789403254.473939')
      expect(result.content[0].text).not.toContain('/')
    } finally {
      gateway.downloadAttachments = real
    }
  })

  test('a failed lookup surfaces as an error, not as an absence of attachments', async () => {
    const { gateway } = await import('../config.js')
    const real = gateway.downloadAttachments
    gateway.downloadAttachments = (async () => {
      throw new Error('message 1789405927.425409 not found in D0BE3RB4Y00')
    }) as typeof gateway.downloadAttachments
    try {
      const result = await executeTool('download_attachment', { chat_id: 'D0BE3RB4Y00', message_id: '1789405927.425409' })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('not found')
    } finally {
      gateway.downloadAttachments = real
    }
  })
})
