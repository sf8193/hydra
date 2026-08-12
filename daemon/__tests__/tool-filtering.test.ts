import { describe, test, expect } from 'bun:test'
import { computeToolsForSession, UNIVERSAL_TOOLS, PROTOCOL_GUEST_DISALLOWED_BUILTINS } from '../bridge-tools.js'
import { MASTER_ORCHESTRATOR_ONLY_TOOLS } from '../../shared/constants.js'

// Suppress stderr
process.stderr.write = (() => true) as any

describe('computeToolsForSession', () => {
  test('main session gets all tools except factory-only', () => {
    const tools = computeToolsForSession('main')
    const names = tools.map(t => t.name)
    expect(names).toContain('reply')
    expect(names).toContain('spawn_session')
    expect(names).toContain('list_sessions')
    expect(names).toContain('kill_session')
    expect(names).toContain('send_to_thread')
    expect(names).toContain('peek_session')
    expect(names).not.toContain('factory_done')
  })

  test('worker session does NOT get spawn/kill tools', () => {
    const tools = computeToolsForSession('some-worker-id')
    const names = tools.map(t => t.name)
    expect(names).toContain('reply')
    expect(names).toContain('react')
    expect(names).toContain('fetch_messages')
    expect(names).toContain('set_description')
    expect(names).toContain('send_to_thread')
    expect(names).toContain('peek_session')
    expect(names).not.toContain('spawn_session')
    expect(names).not.toContain('kill_session')
  })

  test('factory builder with scopedToolOverrides gets factory_done', () => {
    const tools = computeToolsForSession('builder-id', {
      scopedToolOverrides: { factory_done: 'Signal build complete.' },
    })
    const names = tools.map(t => t.name)
    expect(names).toContain('factory_done')
    expect(names).toContain('reply')
    expect(names).not.toContain('spawn_session')
    expect(names).not.toContain('advance')
    const factoryDone = tools.find(t => t.name === 'factory_done')!
    expect(factoryDone.description).toBe('Signal build complete.')
  })

  test('worker with allowMainTools gets spawn/kill tools', () => {
    const tools = computeToolsForSession('some-worker-id', { allowMainTools: true })
    const names = tools.map(t => t.name)
    expect(names).toContain('spawn_session')
    expect(names).toContain('kill_session')
    expect(names).toContain('reply')
    expect(names).toContain('factory_build')
  })

  test('MASTER_ORCHESTRATOR_ONLY_TOOLS restricts spawn and kill', () => {
    expect(MASTER_ORCHESTRATOR_ONLY_TOOLS.has('spawn_session')).toBe(true)
    expect(MASTER_ORCHESTRATOR_ONLY_TOOLS.has('kill_session')).toBe(true)
  })

  test('all UNIVERSAL_TOOLS have required schema fields', () => {
    for (const tool of UNIVERSAL_TOOLS) {
      expect(tool.name).toBeTruthy()
      expect(tool.description).toBeTruthy()
      expect(tool.inputSchema).toBeDefined()
      expect(tool.inputSchema.type).toBe('object')
    }
  })

  test('send_to_thread schema has required fields including type', () => {
    const tool = UNIVERSAL_TOOLS.find(t => t.name === 'send_to_thread')!
    expect(tool).toBeDefined()
    expect(tool.inputSchema.required).toContain('target')
    expect(tool.inputSchema.required).toContain('type')
    expect(tool.inputSchema.required).toContain('text')
    expect(tool.inputSchema.properties).toHaveProperty('target')
    expect(tool.inputSchema.properties).toHaveProperty('type')
    expect(tool.inputSchema.properties).toHaveProperty('text')
    expect(tool.inputSchema.properties).toHaveProperty('files')
    expect((tool.inputSchema.properties as any).type.enum).toEqual(['progress', 'question', 'result'])
  })

  test('peek_session schema has required fields', () => {
    const tool = UNIVERSAL_TOOLS.find(t => t.name === 'peek_session')!
    expect(tool).toBeDefined()
    expect(tool.inputSchema.required).toContain('name')
    expect(tool.inputSchema.properties).toHaveProperty('name')
    expect(tool.inputSchema.properties).toHaveProperty('lines')
  })
})

describe('PROTOCOL_GUEST_DISALLOWED_BUILTINS', () => {
  test('disallows the write/browse/subagent built-ins critics never need', () => {
    for (const name of ['WebSearch', 'WebFetch', 'NotebookEdit', 'Agent', 'Write', 'Edit']) {
      expect(PROTOCOL_GUEST_DISALLOWED_BUILTINS).toContain(name)
    }
  })

  test('keeps review/verify built-ins available (not disallowed)', () => {
    // Critics still read code and run tests — these must NOT be blocked.
    for (const name of ['Read', 'Grep', 'Glob', 'Bash']) {
      expect(PROTOCOL_GUEST_DISALLOWED_BUILTINS).not.toContain(name)
    }
  })

  test('trimming this many built-ins is enough to clear CC deferral headroom', () => {
    // The whole point: shrink the total tool count below CC's ~22 deferral
    // threshold so advance/extend_phase stay callable. Guard the count so a
    // future edit that guts the list is caught.
    expect(PROTOCOL_GUEST_DISALLOWED_BUILTINS.length).toBeGreaterThanOrEqual(6)
  })
})
