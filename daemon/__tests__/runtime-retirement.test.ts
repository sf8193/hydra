import { afterEach, describe, expect, test } from 'bun:test'
import { SessionRuntime } from '../session-runtime.js'
import { engineAdapters } from '../engines/instances.js'
import { registry } from '../sessions.js'
import { completePendingRetirement, listPendingRetirements } from '../retirement-journal.js'
import type { ExecutionRetirementResult, ProviderExecutionRef } from '../engines/engine-adapter.js'

const ref: ProviderExecutionRef = {
  provider: 'codex', sessionId: 'retirement-test-old', codexThreadId: 'native-thread',
  codexHomeName: 'retirement-test-home', ownershipGeneration: 'retirement-test-generation',
}

afterEach(() => {
  completePendingRetirement(ref.ownershipGeneration!)
  registry.delete('retirement-test-successor')
})

function runtime(retireExecution: (ref: ProviderExecutionRef) => Promise<ExecutionRetirementResult>) {
  return new SessionRuntime({
    ...engineAdapters,
    codex: Object.assign(Object.create(engineAdapters.codex), { retireExecution }),
  })
}

describe('runtime retirement ownership and journal', () => {
  test('journals before native retirement and concurrent requests join one operation', async () => {
    let release!: (result: ExecutionRetirementResult) => void
    let attempts = 0
    const current = runtime(async () => {
      attempts++
      expect(listPendingRetirements().some(entry => entry.ownershipGeneration === ref.ownershipGeneration)).toBe(true)
      return new Promise(resolve => { release = resolve })
    })
    const first = current.retire(ref, 'cancel')
    const second = current.retire(ref, 'cancel again')
    expect(attempts).toBe(1)
    release({ status: 'terminal' })
    expect(await first).toEqual({ status: 'terminal' })
    expect(await second).toEqual({ status: 'terminal' })
    expect(listPendingRetirements().some(entry => entry.ownershipGeneration === ref.ownershipGeneration)).toBe(false)
  })

  test('unknown retirement survives two runtime restarts and clears only on terminal evidence', async () => {
    const first = runtime(async () => ({ status: 'unknown', reason: 'socket disconnected' }))
    expect(await first.retire(ref, 'cancel')).toEqual({ status: 'pending', journaled: true, reason: 'socket disconnected' })
    const second = runtime(async () => { throw new Error('still disconnected') })
    await second.replayPendingRetirements()
    expect(listPendingRetirements().some(entry => entry.ownershipGeneration === ref.ownershipGeneration)).toBe(true)
    const replayed: ProviderExecutionRef[] = []
    const third = runtime(async retained => { replayed.push(retained); return { status: 'terminal' } })
    await third.replayPendingRetirements()
    expect(replayed.some(entry => entry.codexThreadId === ref.codexThreadId && entry.ownershipGeneration === ref.ownershipGeneration)).toBe(true)
    expect(listPendingRetirements().some(entry => entry.ownershipGeneration === ref.ownershipGeneration)).toBe(false)
  })

  test('stale generation cannot interrupt a successor owning the same native thread', async () => {
    registry.set('retirement-test-successor', {
      sessionId: 'retirement-test-successor', tmuxName: 'successor', topic: 'test', threadId: 'chat',
      createdAt: 2, lastActive: 2, listening: false, sessionType: 'thread_guest', engine: 'codex',
      codexHomeName: ref.codexHomeName, codexThreadId: ref.codexThreadId, ownershipGeneration: 'new-generation',
    })
    let attempts = 0
    const current = runtime(async () => { attempts++; return { status: 'terminal' } })
    expect(await current.retire(ref, 'stale cancellation')).toEqual({ status: 'terminal' })
    expect(attempts).toBe(0)
    expect(registry.get('retirement-test-successor')).toBeDefined()
  })
})
