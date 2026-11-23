// Bridge registration token authentication (#844): a session with a stored
// sessionTokenHash accepts only a bridge presenting the matching HYDRA_SESSION_TOKEN.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { connect, type Socket } from 'net'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { socketServer } from '../../app/bridge-server.js'
import { pendingPermissions } from '../../app/permission.js'
import { registry } from '../../sessions/registry.js'
import { transport } from '../../sessions/bridge-transport.js'
import { engines } from '../../sessions/engine-instances.js'
import type { SessionInfo } from '../../sessions/registry.js'
import {
  clearPendingSessionToken,
  issueSessionToken,
  notePendingSessionToken,
  verifyBridgeRegistration,
  verifySessionToken,
} from '../../sessions/cli-caller.js'
import { codexAppServerArgs } from '../../engines/codex-process.js'

let dir: string
let sock: string
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'bridge-token-auth-'))
  sock = join(dir, 'd.sock')
  await new Promise<void>(r => socketServer.listen(sock, r))
})
afterAll(() => { socketServer.close(); rmSync(dir, { recursive: true, force: true }) })

function tryRegister(payload: Record<string, unknown>, extraLines: string[] = []): Promise<{ socket: Socket; accepted: boolean; received: string }> {
  return new Promise(resolve => {
    const socket = connect(sock)
    let buf = ''
    let done = false
    const finish = (accepted: boolean) => { if (!done) { done = true; resolve({ socket, accepted, received: buf }) } }
    socket.on('connect', () => {
      const lines = [JSON.stringify(payload), ...extraLines].join('\n') + '\n'
      socket.write(lines)
    })
    socket.on('data', d => {
      buf += d.toString()
      if (buf.includes('"registered"')) finish(true)
    })
    socket.on('close', () => finish(false))
    socket.on('error', () => finish(false))
  })
}

function sendUnregistered(payload: Record<string, unknown>): Promise<{ closed: boolean; received: string }> {
  return new Promise(resolve => {
    const socket = connect(sock)
    let buf = ''
    let done = false
    const finish = (closed: boolean) => { if (!done) { done = true; resolve({ closed, received: buf }) } }
    socket.on('connect', () => { socket.write(JSON.stringify(payload) + '\n') })
    socket.on('data', d => { buf += d.toString() })
    socket.on('close', () => finish(true))
    socket.on('error', () => finish(true))
  })
}

function seedSession(id: string, opts?: { sessionTokenHash?: string; bridgeToken?: true }): SessionInfo {
  const info = {
    sessionId: id, topic: 't', threadId: `thread-${id}`, createdAt: Date.now(), lastActive: Date.now(),
    tmuxName: id, listening: false, engine: 'claude', adapter: engines.claude, sessionType: 'thread_owner',
    claudeSessionId: 'legit-claude-id',
    ...(opts?.sessionTokenHash ? { sessionTokenHash: opts.sessionTokenHash } : {}),
    ...(opts?.bridgeToken ? { bridgeToken: true as const } : {}),
  } as SessionInfo
  registry.set(id, info)
  return info
}

describe('verifySessionToken & verifyBridgeRegistration (pure)', () => {
  test('accepts matching token and rejects missing/wrong/empty token when bridgeToken is required', () => {
    const { token, hash } = issueSessionToken()
    expect(verifySessionToken(token, hash)).toBe(true)
    expect(verifySessionToken('wrong-token', hash)).toBe(false)
    expect(verifySessionToken('', hash)).toBe(false)
    expect(verifySessionToken(undefined, hash)).toBe(false)
    expect(verifySessionToken(token, 'short-corrupt-hash')).toBe(false)

    expect(verifyBridgeRegistration({ sessionToken: token, expectedHash: hash, requireToken: true })).toEqual({ ok: true })
    expect(verifyBridgeRegistration({ sessionToken: undefined, expectedHash: hash, requireToken: true })).toEqual({ ok: false, reason: 'missing session token' })
    expect(verifyBridgeRegistration({ sessionToken: 'wrong', expectedHash: hash, requireToken: true })).toEqual({ ok: false, reason: 'session token does not match' })
  })

  test('rolling-restart compat: pre-deploy record with hash but requireToken=false accepts missing token, still refuses wrong token', () => {
    const { token, hash } = issueSessionToken()
    expect(verifyBridgeRegistration({ sessionToken: undefined, expectedHash: hash, requireToken: false })).toEqual({ ok: true })
    expect(verifyBridgeRegistration({ sessionToken: token, expectedHash: hash, requireToken: false })).toEqual({ ok: true })
    expect(verifyBridgeRegistration({ sessionToken: 'wrong', expectedHash: hash, requireToken: false })).toEqual({ ok: false, reason: 'session token does not match' })
  })

  test('accepts untokened registration when no hash is recorded (main / stray / pre-token)', () => {
    expect(verifyBridgeRegistration({ sessionToken: undefined, expectedHash: undefined, requireToken: false })).toEqual({ ok: true })
    expect(verifyBridgeRegistration({ sessionToken: 'anything', expectedHash: undefined, requireToken: false })).toEqual({ ok: true })
  })
})

describe('socketServer register authentication (#844)', () => {
  test('refuses missing or wrong token for a tokenized session without mutating the record or running pipelined tool calls', async () => {
    const id = 'auth-tok-1'
    const { token, hash } = issueSessionToken()
    const info = seedSession(id, { sessionTokenHash: hash, bridgeToken: true })
    const stderr: string[] = []
    const origWrite = process.stderr.write
    process.stderr.write = ((chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true }) as typeof process.stderr.write
    try {
      const pipelinedCall = JSON.stringify({ type: 'tool_call', id: 'tc-1', name: 'list_sessions', args: {} })
      const missing = await tryRegister({ type: 'register', sessionId: id, claudeSessionId: 'SPOOFED' }, [pipelinedCall])
      expect(missing.accepted).toBe(false)
      expect(missing.received).toBe('')
      expect(info.claudeSessionId).toBe('legit-claude-id')
      expect(transport.get(id)).toBeUndefined()

      const wrong = await tryRegister({ type: 'register', sessionId: id, sessionToken: 'not-the-token', claudeSessionId: 'SPOOFED' }, [pipelinedCall])
      expect(wrong.accepted).toBe(false)
      expect(wrong.received).toBe('')
      expect(info.claudeSessionId).toBe('legit-claude-id')
      expect(transport.get(id)).toBeUndefined()

      // Never leaks tokens into daemon logs.
      expect(stderr.join('')).not.toContain('not-the-token')
      expect(stderr.join('')).not.toContain(token)
      expect(stderr.join('')).toContain('missing session token')
      expect(stderr.join('')).toContain('session token does not match')

      // Valid token succeeds for both session and control bridges.
      const valid = await tryRegister({ type: 'register', sessionId: id, sessionToken: token })
      try {
        expect(valid.accepted).toBe(true)
        expect(transport.get(id)).toBeDefined()
      } finally { valid.socket.destroy() }

      const badControl = await tryRegister({ type: 'register', sessionId: id, sessionToken: 'wrong', connectionRole: 'control' })
      expect(badControl.accepted).toBe(false)

      const validControl = await tryRegister({ type: 'register', sessionId: id, sessionToken: token, connectionRole: 'control' })
      try {
        expect(validControl.accepted).toBe(true)
      } finally { validControl.socket.destroy() }
    } finally {
      process.stderr.write = origWrite
      registry.delete(id)
    }
  })

  test('authenticates bridges connecting during the launch -> registry.set window via pending token hash', async () => {
    const id = 'auth-pending-1'
    const { token, hash } = issueSessionToken()
    notePendingSessionToken(id, hash)
    try {
      const bad = await tryRegister({ type: 'register', sessionId: id })
      expect(bad.accepted).toBe(false)

      const good = await tryRegister({ type: 'register', sessionId: id, sessionToken: token })
      try {
        expect(good.accepted).toBe(true)
      } finally { good.socket.destroy() }
    } finally {
      clearPendingSessionToken(id)
    }
  })

  test('rolling-restart compat: accepts untokened bridge for a pre-deploy session (hash without bridgeToken), still refuses wrong token', async () => {
    const id = 'auth-rolling-1'
    const { hash } = issueSessionToken()
    seedSession(id, { sessionTokenHash: hash })
    try {
      const wrong = await tryRegister({ type: 'register', sessionId: id, sessionToken: 'wrong' })
      expect(wrong.accepted).toBe(false)

      const oldBridge = await tryRegister({ type: 'register', sessionId: id })
      try {
        expect(oldBridge.accepted).toBe(true)
      } finally { oldBridge.socket.destroy() }
    } finally {
      registry.delete(id)
    }
  })

  test('accepts untokened registration for a pre-token legacy session record (no sessionTokenHash)', async () => {
    const id = 'auth-legacy-1'
    seedSession(id)
    const legacy = await tryRegister({ type: 'register', sessionId: id })
    try {
      expect(legacy.accepted).toBe(true)
    } finally {
      legacy.socket.destroy()
      registry.delete(id)
    }
  })

  test('refuses and closes an unregistered socket that sends tool_call, tools_request, or permission_request', async () => {
    const tc = await sendUnregistered({ type: 'tool_call', id: 'tc-unreg', name: 'list_sessions', args: {} })
    expect(tc.closed).toBe(true)
    expect(tc.received).toBe('')

    const tr = await sendUnregistered({ type: 'tools_request', id: 'tr-unreg' })
    expect(tr.closed).toBe(true)
    expect(tr.received).toBe('')

    const permId = 'perm-unreg-1'
    const pr = await sendUnregistered({ type: 'permission_request', request_id: permId, tool_name: 'Bash' })
    expect(pr.closed).toBe(true)
    expect(pr.received).toBe('')
    expect(pendingPermissions.has(permId)).toBe(false)
  })

  test('stops processing pipelined frames after a refused re-register on an already-registered socket', async () => {
    const idA = 'auth-re-a'
    const idB = 'auth-re-b'
    const tokA = issueSessionToken()
    const tokB = issueSessionToken()
    seedSession(idA, { sessionTokenHash: tokA.hash, bridgeToken: true })
    seedSession(idB, { sessionTokenHash: tokB.hash, bridgeToken: true })
    try {
      const valid = await tryRegister({ type: 'register', sessionId: idA, sessionToken: tokA.token })
      expect(valid.accepted).toBe(true)
      const receivedAfter: string[] = []
      const closed = new Promise<void>(resolve => valid.socket.once('close', () => resolve()))
      valid.socket.on('data', chunk => receivedAfter.push(chunk.toString()))

      // Pipeline a bad re-register for B and a tools_request in the same chunk.
      // Without the socket.destroyed break in the line loop, conn.sessionId is still A
      // and the pipelined tools_request would be answered before the socket closes.
      const badReReg = JSON.stringify({ type: 'register', sessionId: idB, sessionToken: 'wrong' })
      const pipelined = JSON.stringify({ type: 'tools_request', id: 'tr-after-bad-rereg' })
      valid.socket.write(`${badReReg}\n${pipelined}\n`)

      await closed
      expect(receivedAfter.join('')).not.toContain('tr-after-bad-rereg')
    } finally {
      registry.delete(idA)
      registry.delete(idB)
    }
  })
})

describe('codexAppServerArgs', () => {
  test('passes -c mcp_servers.hydra.env_vars=["HYDRA_SESSION_TOKEN"] without mutating config.toml or putting the token value on argv', () => {
    const base = codexAppServerArgs()
    expect(base).toContain('mcp_servers.hydra.env_vars=["HYDRA_SESSION_TOKEN"]')
    const withModel = codexAppServerArgs('gpt-5.4')
    expect(withModel).toContain('model="gpt-5.4"')
    expect(withModel).toContain('mcp_servers.hydra.env_vars=["HYDRA_SESSION_TOKEN"]')
  })
})
