import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { SessionRuntime } from '../session-runtime.js'
import { registry } from '../sessions.js'
import { engineAdapters } from '../engines/instances.js'
import { gateway } from '../config.js'
import type { EngineSpawnInput, EngineSpawnResult } from '../engines/engine-adapter.js'

const originalFetch = gateway.fetchChannel
const originalPersist = registry.persist
const originalPick = registry.pickSessionName
const originalCwd = process.env.SPAWN_CWD
let sequence = 0
let created: string[] = []
let persisted: string[][] = []

beforeEach(() => {
  gateway.fetchChannel = async () => ({ isThread: false, isDM: false, parentId: null })
  created = []
  persisted = []
  process.env.SPAWN_CWD = '/tmp/hydra-runtime-fixture'
  registry.pickSessionName = () => `runtime-fixture-${++sequence}`
  registry.persist = () => { persisted.push([...registry.values()].map(s => s.sessionId)) }
})
afterEach(() => {
  for (const id of created) registry.delete(id)
  gateway.fetchChannel = originalFetch
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
})
