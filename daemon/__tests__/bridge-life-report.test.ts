import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { connect, type Socket } from 'net'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { socketServer } from '../bridge-server.js'
import { SOCK_PATH } from '../config.js'
import { BRIDGE_SHUTDOWN_GRACE_MS } from '../../shared/constants.js'
import { appendBridgeLife, bridgeLifePath } from '../../shared/bridge-life.js'

let dir: string
let sock: string
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'bridge-life-report-'))
  sock = join(dir, 'd.sock')
  await new Promise<void>(r => socketServer.listen(sock, r))
})
afterAll(() => { socketServer.close(); rmSync(dir, { recursive: true, force: true }) })

function register(sessionId: string, pid?: number): Promise<Socket> {
  return new Promise(resolve => {
    const socket = connect(sock)
    socket.on('connect', () => socket.write(JSON.stringify({ type: 'register', sessionId, pid }) + '\n'))
    socket.on('data', d => { if (d.toString().includes('"registered"')) resolve(socket) })
  })
}

async function disconnectAndCapture(socket: Socket, expectReport: boolean): Promise<string> {
  const lines: string[] = []
  const report = () => lines.filter(l => l.includes('bridge exit check for session')).join('')
  const spy = spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => { lines.push(String(chunk)); return true }) as typeof process.stderr.write)
  try {
    socket.end()
    if (expectReport) {
      for (let waited = 0; waited < 5_000 && !report(); waited += 50) await Bun.sleep(50)
    } else {
      await Bun.sleep(BRIDGE_SHUTDOWN_GRACE_MS + 1_500)
    }
  } finally {
    spy.mockRestore()
  }
  return report()
}

describe('bridge disconnect report', () => {
  test('a dead bridge: logs its recorded cause and removes the record', async () => {
    const child = Bun.spawn(['true'])
    await child.exited
    const path = bridgeLifePath(dirname(SOCK_PATH), 'life-dead', child.pid)
    appendBridgeLife(path, { ev: 'start', ts: Date.now() - 5_000, pid: child.pid, ppid: 1, sessionId: 'life-dead' })
    appendBridgeLife(path, { ev: 'signal', ts: Date.now(), ppid: 1, detail: 'SIGHUP' })
    const line = await disconnectAndCapture(await register('life-dead', child.pid), true)
    expect(line).toContain(`session life-dead pid ${child.pid}: SIGHUP → pid gone without an exit record`)
    expect(existsSync(path)).toBe(false)
  }, 10_000)

  test('a live bridge: says only the socket dropped and keeps the record', async () => {
    const path = bridgeLifePath(dirname(SOCK_PATH), 'life-alive', process.pid)
    appendBridgeLife(path, { ev: 'start', ts: Date.now(), pid: process.pid, ppid: 1, sessionId: 'life-alive' })
    const line = await disconnectAndCapture(await register('life-alive', process.pid), true)
    expect(line).toContain('no exit record, pid still alive')
    expect(line).toContain(`[record kept: ${path}]`)
    expect(existsSync(path)).toBe(true)
    rmSync(path)
  }, 10_000)

  test('a replaced bridge is not reported: only the owner of the id is', async () => {
    const first = await register('life-replaced', process.pid)
    const second = await register('life-replaced', process.pid)
    const line = await disconnectAndCapture(first, false)
    expect(line).toBe('')
    second.destroy()
  }, 10_000)

  test('a bridge that sent no pid (a stray, or an older bridge) is not reported', async () => {
    const line = await disconnectAndCapture(await register('stray-nopid'), false)
    expect(line).not.toContain('stray-nopid')
  }, 10_000)
})
