// Z1: `hydra attach <name>` end to end. The real CLI runs as a subprocess against
// a unix socket served by the real handleCLIRequest; tmux is the fake shim, which
// logs `attach -t <target>` instead of attaching.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { handleCLIRequest } from '../cli-handler.js'
import { registry } from '../sessions.js'
import { engines } from '../engines/instances.js'
import { withFakeTmux, type FakeTmux } from './fake-tmux.js'

const CLI = join(import.meta.dir, '..', '..', 'cli', 'hydra.ts')

let fake: FakeTmux
let home: string
let server: ReturnType<typeof Bun.listen>
const ids: string[] = []

beforeEach(() => {
  fake = withFakeTmux()
  home = mkdtempSync(join(tmpdir(), 'hz1-'))
  const dir = join(home, '.claude', 'channels', 'test')
  mkdirSync(dir, { recursive: true })
  server = Bun.listen({
    unix: join(dir, 'daemon.sock'),
    socket: {
      async data(socket, data) {
        const res = await handleCLIRequest(JSON.parse(data.toString().split('\n')[0]))
        socket.write(JSON.stringify(res) + '\n')
      },
    },
  })
})

afterEach(() => {
  server.stop(true)
  for (const id of ids.splice(0)) registry.delete(id)
  rmSync(home, { recursive: true, force: true })
  fake.restore()
})

let n = 0
function seed(engine: 'claude' | 'codex', extra: Record<string, unknown> = {}): string {
  const sessionId = `z1-${engine}-${++n}`
  ids.push(sessionId)
  registry.set(sessionId, { sessionId, tmuxName: `z1${engine}${n}`, threadId: `${sessionId}-t`, engine, createdAt: Date.now(),
    adapter: engines[engine], ...extra } as any)
  return `z1${engine}${n}`
}

async function attach(name: string) {
  const p = Bun.spawn(['bun', CLI, 'attach', name], { env: { ...process.env, HOME: home }, stdout: 'pipe', stderr: 'pipe' })
  const [code, stderr] = await Promise.all([p.exited, new Response(p.stderr).text()])
  return { code, stderr, attached: fake.calls().filter(c => c.startsWith('attach')) }
}

describe('hydra attach (Z1)', () => {
  test('claude session → tmux attach to its session', async () => {
    const name = seed('claude'); fake.alive(name)
    const r = await attach(name)
    expect(r.attached).toEqual([`attach -t ${name}`])
    expect(r.code).toBe(0)
  })

  test('codex session → tmux attach to its hydra-chat window', async () => {
    const name = seed('codex', { codexThreadId: 'T-z1' }); fake.alive(name)
    const r = await attach(name)
    expect(r.attached).toEqual([`attach -t ${name}:hydra-chat`])
    expect(r.code).toBe(0)
  })

  test('no surface (tmux gone) → exit 1, nothing attached', async () => {
    const name = seed('claude')
    const r = await attach(name)
    expect(r.code).toBe(1)
    expect(r.attached).toEqual([])
    expect(r.stderr).toContain(name)
  })
})
