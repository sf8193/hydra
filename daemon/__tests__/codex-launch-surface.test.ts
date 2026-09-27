import { describe, expect, test } from 'bun:test'
import { CodexEngineAdapter } from '../engines/codex-engine-adapter.js'

// Fake engine: connected only once connect() resolves with a thread.
function fakeEngine(log: string[]) {
  let connected = false
  return {
    queueTurn: () => { log.push('queue'); return true },
    connect: async () => { connected = true; log.push('connect'); return { threadId: 'thread-1', model: 'm' } },
    connectAndFork: async () => { throw new Error('unused') },
    disconnect: () => { connected = false },
    isConnected: () => connected,
  }
}

function adapterWith(log: string[], surface: (info: any, engine: any) => boolean) {
  const engine = fakeEngine(log)
  const adapter = new CodexEngineAdapter(engine as any) as any
  adapter.startAppServer = () => { log.push('start'); return '/tmp/spawn.log' }
  adapter.surface = (info: any) => {
    log.push(`surface:${info.codexThreadId}:${engine.isConnected() ? 'connected' : 'disconnected'}`)
    return surface(info, engine) ? `${info.tmuxName}:hydra-chat` : null
  }
  return adapter
}

const input = { sessionId: 's1', tmuxName: 'codex-t', cwd: '/tmp', originalCwd: '/tmp', model: 'm', prompt: 'hi' }

describe('CodexEngineAdapter.launch surface', () => {
  test('creates the surface after the thread is connected and before returning', async () => {
    const log: string[] = []
    const adapter = adapterWith(log, () => true)
    const result = await adapter.launch(input)
    expect(log).toEqual(['start', 'queue', 'connect', 'surface:thread-1:connected'])
    expect(result.identity.codexThreadId).toBe('thread-1')
  })

  test('a failed surface does not fail the launch', async () => {
    const log: string[] = []
    const adapter = adapterWith(log, () => false)
    const result = await adapter.launch(input)
    expect(log).toContain('surface:thread-1:connected')
    expect(result).toEqual({ provider: 'codex', model: 'm', identity: { codexThreadId: 'thread-1' }, spawnLogPath: '/tmp/spawn.log' })
  })
})
