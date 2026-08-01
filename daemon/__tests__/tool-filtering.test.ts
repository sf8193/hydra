import { describe, test, expect } from 'bun:test'
import { computeToolsForSession, UNIVERSAL_TOOLS } from '../bridge-tools.js'
import { MASTER_ORCHESTRATOR_ONLY_TOOLS } from '../../shared/constants.js'

// Suppress stderr
process.stderr.write = (() => true) as any

describe('computeToolsForSession', () => {
  test('main session gets all tools', () => {
    const tools = computeToolsForSession('main')
    expect(tools).toBe(UNIVERSAL_TOOLS) // same reference
    const names = tools.map(t => t.name)
    expect(names).toContain('reply')
    expect(names).toContain('spawn_session')
    expect(names).toContain('list_sessions')
    expect(names).toContain('kill_session')
    expect(names).toContain('send_to_thread')
    expect(names).toContain('peek_session')
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
