// Register-handler wiring for the flap circuit breaker: when a second bridge fights the live
// one for the same session id, the incumbent is held and the session is NOT killed.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { connect, type Socket } from 'net'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { socketServer } from '../bridge-server.js'
import { registry } from '../sessions.js'
import { transport } from '../bridge-transport.js'
import { engines } from '../engines/instances.js'
import type { SessionInfo } from '../sessions.js'

let dir: string
let sock: string
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'bridge-flap-'))
  sock = join(dir, 'd.sock')
  await new Promise<void>(r => socketServer.listen(sock, r))
})
afterAll(() => { socketServer.close(); rmSync(dir, { recursive: true, force: true }) })

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// A bridge client: registers as `id`, resolves once the server answered 'registered' or closed on it.
function bridge(id: string, claudeSessionId?: string, connectionRole?: string): Promise<{ socket: Socket; accepted: boolean }> {
  return new Promise(resolve => {
    const socket = connect(sock)
    let buf = ''
    let done = false
    const finish = (accepted: boolean) => { if (!done) { done = true; resolve({ socket, accepted }) } }
    socket.on('connect', () => socket.write(JSON.stringify({ type: 'register', sessionId: id, claudeSessionId, connectionRole }) + '\n'))
    socket.on('data', d => { buf += d.toString(); if (buf.includes('"registered"')) finish(true) })
    socket.on('close', () => finish(false))
    socket.on('error', () => finish(false))
  })
}

function session(id: string): SessionInfo {
  const info = {
    sessionId: id, topic: 't', threadId: `thread-${id}`, createdAt: Date.now(), lastActive: Date.now(),
    tmuxName: id, listening: false, engine: 'claude', adapter: engines.claude, sessionType: 'thread_owner',
  } as SessionInfo
  registry.set(id, info)
  return info
}

describe('bridge flap circuit breaker', () => {
  test('two bridges fighting over one session id: the incumbent is held, the session is not killed', async () => {
    const id = 'flap-hold-1'
    const info = session(id)
    const sockets: Socket[] = []
    const accepted: boolean[] = []
    info.claudeSessionId = 'legit'
    for (let i = 0; i < 14; i++) {
      const b = await bridge(id, i < 9 ? 'legit' : 'INTRUDER') // the refused ones carry a different Claude session
      sockets.push(b.socket)
      accepted.push(b.accepted)
      await sleep(15)
    }
    try {
      expect(info.deadAt).toBeUndefined()                 // not killed by the breaker
      expect(info.claudeSessionId).toBe('legit')          // a refused registration must not overwrite the resume id
      expect(transport.get(id)).toBeDefined()             // someone still holds the id
      expect(accepted.slice(0, 9).every(Boolean)).toBe(true)   // normal replacements before the threshold
      expect(accepted.slice(9).every(a => !a)).toBe(true)      // then every newcomer inside the hold is refused
    } finally {
      for (const s of sockets) s.destroy()
      registry.delete(id)
    }
  })

  test('the hold ends with the incumbent: once it dies, the next bridges are accepted again', async () => {
    const id = 'flap-hold-2'
    const info = session(id)
    const fight: Socket[] = []
    for (let i = 0; i < 12; i++) { fight.push((await bridge(id)).socket); await sleep(15) }
    for (const s of fight) s.destroy()
    await sleep(150) // the server notices every close
    const b = await bridge(id)
    const c = await bridge(id) // inside the 10s cooldown, but the held incumbent is gone
    try {
      expect(info.deadAt).toBeUndefined()
      expect([b.accepted, c.accepted]).toEqual([true, true])
    } finally { b.socket.destroy(); c.socket.destroy(); registry.delete(id) }
  })

  test('control (tool-only sidecar) registrations are exempt: 15 of them neither refuse nor kill', async () => {
    const id = 'flap-control-1'
    const info = session(id)
    const sockets: Socket[] = []
    const accepted: boolean[] = []
    for (let i = 0; i < 15; i++) { const b = await bridge(id, undefined, 'control'); sockets.push(b.socket); accepted.push(b.accepted); await sleep(10) }
    try {
      expect(info.deadAt).toBeUndefined()
      expect(accepted.every(Boolean)).toBe(true)
    } finally { for (const s of sockets) s.destroy(); registry.delete(id) }
  })
})

