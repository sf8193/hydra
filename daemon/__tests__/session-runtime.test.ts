import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { SessionRuntime } from '../session-runtime.js'
import { registry, type SessionInfo } from '../sessions.js'
import { engineAdapters } from '../engines/instances.js'
import { gateway } from '../config.js'
import type { EngineSpawnInput, EngineSpawnResult } from '../engines/engine-adapter.js'
import { completePendingRetirement, listPendingRetirements } from '../retirement-journal.js'

const originalFetch = gateway.fetchChannel
const originalUrl = gateway.getThreadUrl
const originalPersist = registry.persist
const originalPick = registry.pickSessionName
const originalCwd = process.env.SPAWN_CWD
let sequence = 0
let created: string[] = []
let persisted: string[][] = []

beforeEach(() => {
  gateway.fetchChannel = async () => ({ isThread: false, isDM: false, parentId: null })
  gateway.getThreadUrl = async () => ''
  created = []
  persisted = []
  process.env.SPAWN_CWD = '/tmp/hydra-runtime-fixture'
  registry.pickSessionName = () => `runtime-fixture-${++sequence}`
  registry.persist = () => { persisted.push([...registry.values()].map(s => s.sessionId)) }
})
afterEach(() => {
  for (const id of created) {
    const info = registry.get(id)
    if (info && registry.getByThread(info.threadId) === id) registry.deleteThread(info.threadId)
    if (info) registry.removeMember(info.threadId, id)
    registry.delete(id)
    completePendingRetirement(id)
  }
  gateway.fetchChannel = originalFetch
  gateway.getThreadUrl = originalUrl
  registry.persist = originalPersist
  registry.pickSessionName = originalPick
  if (originalCwd === undefined) delete process.env.SPAWN_CWD
  else process.env.SPAWN_CWD = originalCwd
})

function runtime(launch: (input: EngineSpawnInput<'claude'>) => Promise<EngineSpawnResult<'claude'>>) {
  return new SessionRuntime({
    claude: Object.assign(Object.create(engineAdapters.claude), { spawn: (input: EngineSpawnInput<'claude'>) => { created.push(input.sessionId); return launch(input) } }),
    codex: Object.assign(Object.create(engineAdapters.codex), { spawn: async () => { throw new Error('wrong adapter') } }),
  })
}

describe('SessionRuntime lifecycle characterization — L01/L13/L19/L25/L28', () => {
  test('concurrent kills join shutdown and retain ownership until it completes', async () => {
    let release!: () => void
    let stops = 0
    const current = new SessionRuntime({
      ...engineAdapters,
      claude: Object.assign(Object.create(engineAdapters.claude), {
        stop: () => { stops++; return new Promise<void>(resolve => { release = resolve }) },
      }),
    })
    const info: SessionInfo = {
      sessionId: 'runtime-kill', tmuxName: 'runtime-kill', topic: 'test', threadId: 'synthetic-kill',
      createdAt: 1, lastActive: 1, listening: false, sessionType: 'thread_owner', headless: true,
      claudeSessionId: 'native',
    }
    created.push(info.sessionId)
    registry.set(info.sessionId, info)
    const first = current.kill(info, 'test')
    const second = current.kill(info, 'test')
    let secondCompleted = false
    void second.then(() => { secondCompleted = true })
    await Promise.resolve()
    expect(secondCompleted).toBe(false)
    expect(registry.get(info.sessionId)).toBe(info)
    expect(stops).toBe(1)
    release()
    await Promise.all([first, second])
    expect(registry.get(info.sessionId)).toBeUndefined()
  })

  test('stale kill cannot stop a successor with the same name', async () => {
    const info: SessionInfo = {
      sessionId: 'runtime-successor', tmuxName: 'runtime-reused', topic: 'test', threadId: 'synthetic-reused',
      createdAt: 2, lastActive: 2, listening: false, sessionType: 'thread_owner', headless: true,
    }
    created.push(info.sessionId)
    registry.set(info.sessionId, info)
    let stops = 0
    const current = new SessionRuntime({
      ...engineAdapters,
      claude: Object.assign(Object.create(engineAdapters.claude), { stop: async () => { stops++ } }),
    })
    await expect(current.kill({ ...info, sessionId: 'runtime-predecessor', createdAt: 1 }, 'stale')).rejects.toThrow('stale session')
    expect(stops).toBe(0)
    expect(registry.get(info.sessionId)).toBe(info)
  })

  test('Claude identity is unpublished until native launch succeeds', async () => {
    let release!: (result: EngineSpawnResult<'claude'>) => void
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const current = runtime(() => new Promise(resolve => { release = resolve; entered() }))
    const spawning = current.spawn('test task', undefined, undefined, { headless: true, model: 'sonnet' })
    await started
    expect(created).toHaveLength(1)
    expect(registry.get(created[0])).toBeUndefined()
    expect(persisted).toHaveLength(0)
    release({ provider: 'claude', nativeIdentity: { provider: 'claude', sessionId: 'native-id' } })
    const result = await spawning
    expect(registry.get(result.sessionId)).toMatchObject({ claudeSessionId: 'native-id', headless: true })
    expect(persisted.at(-1)).toContain(result.sessionId)
    expect(registry.getByThread(result.threadId)).toBeUndefined()
  })

  test('failed native launch leaves no published registry identity', async () => {
    const current = runtime(async () => { throw new Error('native launch failed') })
    await expect(current.spawn('test task', undefined, undefined, { headless: true })).rejects.toThrow('native launch failed')
    expect(created).toHaveLength(1)
    expect(registry.get(created[0])).toBeUndefined()
    expect(registry.getByThread(created[0])).toBeUndefined()
    expect(persisted).toHaveLength(0)
  })

  test('concurrent Claude launches reserve distinct names before publication and release on failure', async () => {
    const names = ['runtime-reserved-a', 'runtime-reserved-b']
    registry.pickSessionName = () => names.find(name => !registry.reservedNames.has(name))!
    let rejectFirst!: (error: Error) => void
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const observed: string[] = []
    const current = runtime(input => {
      observed.push(input.tmuxName)
      if (observed.length === 1) return new Promise((_resolve, reject) => { rejectFirst = reject; entered() })
      return Promise.reject(new Error('second failed'))
    })
    const first = current.spawn('first', undefined, undefined, { headless: true })
    await started
    expect(registry.reservedNames.has(names[0])).toBe(true)
    await expect(current.spawn('second', undefined, undefined, { headless: true })).rejects.toThrow('second failed')
    expect(observed).toEqual(names)
    expect(registry.reservedNames.has(names[1])).toBe(false)
    rejectFirst(new Error('first failed'))
    await expect(first).rejects.toThrow('first failed')
    expect(registry.reservedNames.has(names[0])).toBe(false)
  })

  test('resolved model and native resume intent reach the selected adapter', async () => {
    let received!: EngineSpawnInput<'claude'>
    const current = runtime(async input => { received = input; return { provider: 'claude' } })
    await current.spawn('resume task', undefined, undefined, { headless: true, model: 'sonnet', resumeFrom: 'saved-native-id' })
    expect(received.model).toContain('claude-sonnet')
    expect(received.mode).toEqual({ kind: 'resume', source: { provider: 'claude', sessionId: 'saved-native-id' } })
    expect(received.cwd).toBe('/tmp/hydra-runtime-fixture')
  })

  test('committed replacement carries artifacts, context links and description', async () => {
    const current = runtime(async () => ({ provider: 'claude' }))
    const carryOver = { artifacts: ['https://example.test/pr/1'], contextLinks: ['https://example.test/context'], description: 'ongoing work' }
    const result = await current.spawn('replacement', undefined, undefined, { headless: true, carryOver })
    expect(registry.get(result.sessionId)).toMatchObject(carryOver)
  })

  test('post-launch failure stops Claude before releasing its name', async () => {
    gateway.getThreadUrl = async () => { throw new Error('URL failed') }
    let stopped = false
    const current = new SessionRuntime({
      ...engineAdapters,
      claude: Object.assign(Object.create(engineAdapters.claude), {
        spawn: async (input: EngineSpawnInput<'claude'>) => {
          created.push(input.sessionId)
          return { provider: 'claude' }
        },
        stop: async (info: { tmuxName: string }) => {
          expect(registry.reservedNames.has(info.tmuxName)).toBe(true)
          stopped = true
        },
      }),
    })
    await expect(current.spawn('test', undefined, undefined, { existingThreadId: 'rollback-thread' })).rejects.toThrow('URL failed')
    expect(stopped).toBe(true)
    expect(registry.get(created[0])).toBeUndefined()
    expect(listPendingRetirements().some(ref => ref.sessionId === created[0])).toBe(false)
  })

  test('failed stop preserves the native owner and durable retirement', async () => {
    gateway.getThreadUrl = async () => { throw new Error('URL failed') }
    const current = new SessionRuntime({
      ...engineAdapters,
      claude: Object.assign(Object.create(engineAdapters.claude), {
        spawn: async (input: EngineSpawnInput<'claude'>) => {
          created.push(input.sessionId)
          return { provider: 'claude' }
        },
        stop: async () => { throw new Error('still running') },
      }),
    })
    await expect(current.spawn('test', undefined, undefined, { existingThreadId: 'rollback-thread' })).rejects.toThrow('cleanup remains pending')
    expect(registry.get(created[0])).toBeDefined()
    expect(listPendingRetirements().some(ref => ref.sessionId === created[0])).toBe(true)
  })

  test.each(['owner', 'guest'] as const)('failed Codex pre-launch callback removes provisional %s routing', async role => {
    const threadId = 'codex-rollback-thread'
    if (role === 'guest') registry.setThread(threadId, 'existing-owner')
    let launches = 0
    const current = new SessionRuntime({
      ...engineAdapters,
      codex: Object.assign(Object.create(engineAdapters.codex), {
        spawn: async () => { launches++; throw new Error('must not launch') },
      }),
    })
    try {
      await expect(current.spawn('test', undefined, undefined, {
        engine: 'codex', ...(role === 'guest' ? { joinThread: threadId } : { existingThreadId: threadId }),
        beforeInitialTurn: id => {
          created.push(id)
          expect(registry.get(id)).toBeDefined()
          throw new Error('capabilities failed')
        },
      })).rejects.toThrow('capabilities failed')
      expect(launches).toBe(0)
      expect(registry.get(created[0])).toBeUndefined()
      expect(registry.getMembers(threadId)).toHaveLength(0)
      expect(registry.getByThread(threadId)).toBe(role === 'guest' ? 'existing-owner' : undefined)
    } finally { registry.deleteThread(threadId) }
  })
})
