import { describe, expect, test, afterEach } from 'bun:test'
import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'
import { BridgeTransport, deliverToAdapter, setDeliveryGate } from '../../sessions/bridge-transport.js'
import { registry, type SessionInfo } from '../../sessions/registry.js'

const root = join(import.meta.dir, '..', '..')
const info = (deliver: () => Promise<unknown>) => ({ sessionId: 's', adapter: { deliver } }) as unknown as SessionInfo
const note = { type: 'notification', content: 'hi' } as never

afterEach(() => setDeliveryGate(() => undefined))

describe('deliverToAdapter: the one drift gate in front of every engine', () => {
  test('a refusal from the gate is a non-retryable rejection, and the engine is never called', async () => {
    let called = 0
    setDeliveryGate(() => 'policy drifted')
    const r = await deliverToAdapter(info(async () => { called++; return { status: 'accepted', via: 'x' } }), note, true)
    expect(r).toEqual({ status: 'rejected', retryable: false, reason: 'policy drifted' })
    expect(called).toBe(0)
  })

  test('with no gate set nothing is delivered', async () => {
    let called = 0
    setDeliveryGate(undefined)
    const r = await deliverToAdapter(info(async () => { called++; return { status: 'accepted', via: 'x' } }), note, true)
    expect(r).toMatchObject({ status: 'rejected', retryable: false })
    expect(called).toBe(0)
  })

  test('a gate that throws is an unknown outcome through the transport, not a crash', async () => {
    setDeliveryGate(() => { throw new Error('gate broke') })
    registry.set('gt-1', { sessionId: 'gt-1', tmuxName: 'gt-1', threadId: 't', adapter: { deliver: async () => ({ status: 'accepted', via: 'x' }) } } as never)
    try {
      expect(await new BridgeTransport().deliver('gt-1', { type: 'notification', content: 'hi' })).toMatchObject({ status: 'unknown' })
    } finally { registry.delete('gt-1') }
  })

  test('no refusal: the engine answers', async () => {
    setDeliveryGate(() => undefined)
    expect(await deliverToAdapter(info(async () => ({ status: 'accepted', via: 'x' })), note, true)).toEqual({ status: 'accepted', via: 'x' })
  })

  test('no production file calls adapter.deliver except deliverToAdapter, so no route skips the gate', () => {
    const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '*.ts'], { cwd: root, encoding: 'utf8' }).split('\n')
      .filter(f => f && !/(^|\/)(__tests__|node_modules)\//.test(f) && !f.startsWith('scripts/') && !f.endsWith('.test.ts'))
    const hits = files.filter(f => /\badapter[!?]*\.deliver\b|\badapter[!?]*\.?\[\s*['"]deliver['"]\s*\]/.test(readFileSync(join(root, f), 'utf8').replace(/\/\/.*$/gm, '')))
    expect(hits).toEqual(['sessions/bridge-transport.ts'])
  })
})
