import { describe, test, expect } from 'bun:test'
import { computeToolsForSession, UNIVERSAL_TOOLS } from '../bridge-tools.js'
import { BASE_TOOLS, CAPABILITY_TOOLS } from '../../shared/constants.js'

// Suppress stderr
process.stderr.write = (() => true) as any

describe('computeToolsForSession', () => {
  test('master_orchestrator gets orchestrator tools but not factory_done', () => {
    const tools = computeToolsForSession('master_orchestrator', new Set())
    const names = tools.map(t => t.name)
    expect(names).toContain('reply')
    expect(names).toContain('spawn_session')
    expect(names).toContain('list_sessions')
    expect(names).toContain('kill_session')
    expect(names).toContain('send_to_thread')
    expect(names).toContain('peek_session')
    expect(names).not.toContain('factory_done')
    expect(names).not.toContain('advance')
    expect(names).not.toContain('extend_phase')
  })

  test('thread_owner does NOT get orchestrator-only tools', () => {
    const tools = computeToolsForSession('thread_owner', new Set())
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

  test('factory_builder gets restricted tool set with factory_done', () => {
    const tools = computeToolsForSession('factory_builder', new Set())
    const names = tools.map(t => t.name)
    expect(names).toContain('reply')
    expect(names).toContain('fetch_messages')
    expect(names).toContain('send_to_thread')
    expect(names).toContain('factory_done')
    expect(names).not.toContain('react')
    expect(names).not.toContain('edit_message')
    expect(names).not.toContain('spawn_session')
    expect(tools).toHaveLength(6)
  })

  test('factory_builder description override applies to factory_done', () => {
    const tools = computeToolsForSession('factory_builder', new Set(), { descriptions: { factory_done: 'Signal build complete.' } })
    const factoryDone = tools.find(t => t.name === 'factory_done')!
    expect(factoryDone.description).toBe('Signal build complete.')
  })

  test('spawn_session and kill_session only in master_orchestrator base set', () => {
    expect(BASE_TOOLS.master_orchestrator.has('spawn_session')).toBe(true)
    expect(BASE_TOOLS.master_orchestrator.has('kill_session')).toBe(true)
    expect(BASE_TOOLS.thread_owner.has('spawn_session')).toBe(false)
    expect(BASE_TOOLS.thread_owner.has('kill_session')).toBe(false)
    expect(BASE_TOOLS.thread_guest.has('spawn_session')).toBe(false)
    expect(BASE_TOOLS.thread_guest.has('kill_session')).toBe(false)
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

  test('BASE_TOOLS sizes match design spec', () => {
    expect(BASE_TOOLS.master_orchestrator.size).toBe(22)
    expect(BASE_TOOLS.thread_owner.size).toBe(13)
    expect(BASE_TOOLS.thread_guest.size).toBe(8)
    expect(BASE_TOOLS.factory_builder.size).toBe(6)
  })

  test('thread_guest base set includes advance and extend_phase', () => {
    const tools = computeToolsForSession('thread_guest', new Set())
    const names = tools.map(t => t.name)
    expect(names).toContain('advance')
    expect(names).toContain('extend_phase')
    expect(names).toContain('reply')
    expect(names).not.toContain('spawn_session')
    expect(names).not.toContain('factory_build')
    expect(tools).toHaveLength(8)
  })

  test('description overrides apply to matching tools', () => {
    const tools = computeToolsForSession('thread_owner', new Set(['protocol_context']), {
      descriptions: { advance: 'Custom advance description' },
    })
    const advance = tools.find(t => t.name === 'advance')!
    expect(advance.description).toBe('Custom advance description')
    const extendPhase = tools.find(t => t.name === 'extend_phase')!
    expect(extendPhase.description).not.toBe('Custom advance description')
  })

  test('factory_builder with protocol_context gets advance alongside factory_done', () => {
    const tools = computeToolsForSession('factory_builder', new Set(['protocol_context']))
    const names = tools.map(t => t.name)
    expect(names).toContain('factory_done')
    expect(names).toContain('advance')
    expect(names).toContain('extend_phase')
    expect(names).toContain('reply')
  })

  test('factory_builder base set has factory_done without capabilities', () => {
    const tools = computeToolsForSession('factory_builder', new Set())
    const names = tools.map(t => t.name)
    expect(names).toContain('factory_done')
    expect(names).toContain('reply')
    expect(names).not.toContain('advance')
    expect(names).not.toContain('spawn_session')
    expect(tools).toHaveLength(6)
  })

  test('inputSchema overrides replace tool schema', () => {
    const noVerdictSchema = { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] }
    const tools = computeToolsForSession('thread_guest', new Set(['protocol_context']), { inputSchemas: { advance: noVerdictSchema } })
    const advance = tools.find(t => t.name === 'advance')!
    expect(advance.inputSchema).toEqual(noVerdictSchema)
    expect((advance.inputSchema as any).properties.verdict).toBeUndefined()
  })

  test('inputSchema override does not affect other tools', () => {
    const schema = { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] }
    const tools = computeToolsForSession('thread_guest', new Set(['protocol_context']), { inputSchemas: { advance: schema } })
    const extend = tools.find(t => t.name === 'extend_phase')!
    expect((extend.inputSchema as any).properties.reason).toBeDefined()
  })

  test('verdict required schema makes verdict required', () => {
    const requiredSchema = { type: 'object', properties: { content: { type: 'string' }, verdict: { type: 'string' } }, required: ['content', 'verdict'] }
    const tools = computeToolsForSession('thread_guest', new Set(['protocol_context']), { inputSchemas: { advance: requiredSchema } })
    const advance = tools.find(t => t.name === 'advance')!
    expect((advance.inputSchema as any).required).toContain('verdict')
  })

  test('all tool names in constants reference UNIVERSAL_TOOLS', () => {
    const universalNames = new Set(UNIVERSAL_TOOLS.map(t => t.name))
    for (const [, tools] of Object.entries(BASE_TOOLS)) {
      for (const name of tools as Iterable<string>) expect(universalNames.has(name)).toBe(true)
    }
    for (const [, tools] of Object.entries(CAPABILITY_TOOLS)) {
      for (const name of tools as Iterable<string>) expect(universalNames.has(name)).toBe(true)
    }
  })
})
