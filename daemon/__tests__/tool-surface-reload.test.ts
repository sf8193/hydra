// A hydra.toml reload reaches the tool list a running session holds. `sends_to` is read live (app/sends-to.ts judges every send),
// so the list must follow it: a restricted session born with no target gains send_to_thread when a reload adds one, and loses it when
// a reload empties the list. Only a session whose list changed is told; the others hear nothing.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { connect, type Socket } from 'net'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { STATE_DIR } from '../../infra/config.js'
import { socketServer } from '../../app/bridge-server.js'
import { registry } from '../../sessions/registry.js'
import { _setHydraConfigForTesting } from '../../infra/hydra-config.js'
import { setSpecialistThread, _reloadSpecialists } from '../../sessions/specialists.js'
import { loadHydraConfig } from '../../config/load.js'
import { testLoadEnv } from '../../config/__tests__/load-env.js'
import { engines } from '../../engines/instances.js'
import type { HydraConfig } from '../../config/types.js'
import type { SessionInfo } from '../../sessions/registry.js'

process.stderr.write = (() => true) as any

const load = (text: string): HydraConfig => {
  const r = loadHydraConfig(text, testLoadEnv({ home: '/home/op', sessionNames: ['spark'], isCommand: () => true }))
  if (!r.ok) throw new Error(r.errors.map(i => `${i.path}: ${i.message}`).join('\n'))
  return r.config
}
const toml = (plainSendsTo: string) => `
operator = "op"
[people.op]
addresses = ["slack:U0OP"]
[slack.apps.default]
bot_token_env = "CONNECTOR_SLACK_BOT_TOKEN"
[specialists.ops]
workdir = "~/agents/ops"
reachable_by = ["role:anyone"]
restricted = true
sends_to = ["plain"]
[[rules]]
place = "slack:C0OPS"
target = "specialist:ops"
[specialists.plain]
workdir = "~/agents/plain"
reachable_by = ["role:anyone"]
restricted = true
${plainSendsTo}
[[rules]]
place = "slack:C0PLAIN"
target = "specialist:plain"
`
const EMPTY = toml('sends_to = []')
const ADDED = toml('sends_to = ["ops"]')

let dir: string
let sock: string
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tool-reload-'))
  sock = join(dir, 'd.sock')
  await new Promise<void>(r => socketServer.listen(sock, r))
})
afterAll(() => { socketServer.close(); rmSync(dir, { recursive: true, force: true }) })

type Bridge = { socket: Socket; received: Array<Record<string, any>> }
// A bridge client: registers as `id` and keeps every message the daemon writes to it.
function bridge(id: string): Promise<Bridge> {
  return new Promise((resolve, reject) => {
    const socket = connect(sock)
    const received: Array<Record<string, any>> = []
    let buf = ''
    socket.on('connect', () => socket.write(JSON.stringify({ type: 'register', sessionId: id, restricted: true }) + '\n'))
    socket.on('data', d => {
      buf += d.toString()
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
        if (!line) continue
        const msg = JSON.parse(line)
        received.push(msg)
        if (msg.type === 'registered') resolve({ socket, received })
      }
    })
    socket.on('error', reject)
  })
}

const ids: string[] = []
const sockets: Socket[] = []
function session(id: string, specialist: string): SessionInfo {
  ids.push(id)
  const threadId = `${specialist}-thread`
  setSpecialistThread(specialist, threadId)
  const info = {
    sessionId: id, topic: 't', threadId, tmuxName: id, createdAt: Date.now(), lastActive: Date.now(), listening: false,
    engine: 'claude', adapter: engines.claude, sessionType: 'thread_owner', policy: { specialist, restricted: true, id: 'x' },
  } as unknown as SessionInfo
  registry.set(id, info)
  return info
}
const names = (msg: Record<string, any>): string[] => (msg.tools as Array<{ name: string }>).map(t => t.name)
const updates = (b: Bridge) => b.received.filter(m => m.type === 'tools_update')
const settle = () => new Promise(r => setTimeout(r, 50))

beforeEach(() => { _setHydraConfigForTesting(load(EMPTY)) })
afterEach(() => {
  for (const s of sockets.splice(0)) s.destroy()
  for (const id of ids.splice(0)) registry.delete(id)
  _setHydraConfigForTesting(undefined)
  rmSync(join(STATE_DIR, 'specialist-threads.json'), { force: true }); _reloadSpecialists()
})

describe('a hydra.toml reload pushes the tool list to the running sessions whose list it changed', () => {
  test('born with sends_to = [], a session gets send_to_thread when a reload adds a target, and loses it when a reload empties the list', async () => {
    session('plain-s', 'plain')
    const b = await bridge('plain-s'); sockets.push(b.socket)
    const registered = b.received.find(m => m.type === 'registered')!
    expect(names(registered)).not.toContain('send_to_thread')

    _setHydraConfigForTesting(load(ADDED))
    await settle()
    expect(updates(b)).toHaveLength(1)
    expect(names(updates(b)[0])).toContain('send_to_thread')

    _setHydraConfigForTesting(load(EMPTY))
    await settle()
    expect(updates(b)).toHaveLength(2)
    expect(names(updates(b)[1])).not.toContain('send_to_thread')
  })

  test('a session whose list the reload did not change is told nothing', async () => {
    session('ops-s', 'ops')
    const b = await bridge('ops-s'); sockets.push(b.socket)
    expect(names(b.received.find(m => m.type === 'registered')!)).toContain('send_to_thread')

    _setHydraConfigForTesting(load(ADDED))   // changes plain's list, not ops's
    await settle()
    _setHydraConfigForTesting(load(EMPTY))
    await settle()
    expect(updates(b)).toEqual([])
  })
})
