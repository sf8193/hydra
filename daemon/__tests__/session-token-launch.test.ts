// Each session kind is launched with its token (cli-caller.ts) where its shell's hydra CLI reads it, and never on a command line:
// Claude (operator and restricted) and omp by a launch file their pane exports and removes, Codex in its app-server's environment.
// The CLI says who calls from that environment (shared/caller.ts), and nothing that drops an identity keeps the token.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ClaudeEngine, askForkEnv } from '../../engines/claude-engine.js'
import { OmpEngine } from '../../engines/omp-engine.js'
import { CodexEngineAdapter } from '../../engines/codex-engine-adapter.js'
import { removeLaunchFiles, sessionTokenDir, writeSessionToken } from '../../infra/launch-files.js'
import { type RestrictedPolicy } from '../../shared/launch-policy.js'
import { policyIdFor } from '../../app/restricted.js'
import { _setLoadEnvForTesting } from '../../infra/hydra-config.js'
import { callerClaim, SESSION_TOKEN_VAR } from '../../shared/caller.js'
import { codexSpawnEnv, SESSION_IDENTITY_VARS } from '../../shared/spawn-env.js'
import { macLike } from './sandbox-host.js'
import { withFakeTmux, type FakeTmux } from './fake-tmux.js'
import { codexAdapter } from './codex-adapter.js'
import { claudeBuiltins } from '../../engines/write-confinement.js'

process.stderr.write = (() => true) as any

const TOKEN = 'a'.repeat(64)
const SID = '22222222-2222-4222-8222-222222222222'
const restricted: RestrictedPolicy = { specialist: 'ops', restricted: true, workdir: '/work/ops', tools: ['Read'], servers: [], id: policyIdFor('/work/ops', ['Read'], []) }
const base = { sessionId: SID, tmuxName: 'tok-t', cwd: '/tmp', originalCwd: '/tmp', model: 'claude-opus-4-1', prompt: 'p', sessionType: 'thread_owner' as const, sessionToken: TOKEN }
const tokenFile = join(sessionTokenDir(), `tok-t-${SID}.token`)

let fake: FakeTmux
// A restricted launch reads Claude Code's built-in list: fixed here, so the real `claude plugin list` is never run.
const realList = claudeBuiltins.list
beforeEach(() => { fake = withFakeTmux(); _setLoadEnvForTesting(macLike()); claudeBuiltins.list = () => [] })
afterEach(() => { fake.restore(); _setLoadEnvForTesting(undefined); claudeBuiltins.list = realList; removeLaunchFiles({ tmuxName: 'tok-t', sessionId: SID }) })

async function claudeCommand(extra: Record<string, unknown> = {}): Promise<string> {
  await new ClaudeEngine({} as any).launch({ ...base, ...extra } as any)
  return fake.calls().findLast(c => c.startsWith('new-session'))!
}

describe('Claude: by launch file, exported then removed by the pane', () => {
  for (const [kind, extra] of [['an operator session', {}], ['a restricted specialist', { policy: restricted }], ['a resume', { continuation: { kind: 'resume-claude', claudeSessionId: 'C-old' } }]] as const) {
    test(kind, async () => {
      const cmd = await claudeCommand(extra)
      expect(cmd).not.toContain(TOKEN)
      expect(cmd).toContain(`${SESSION_TOKEN_VAR}=$(cat '${tokenFile}') && export ${SESSION_TOKEN_VAR} && rm -f '${tokenFile}'`)
      expect(readFileSync(tokenFile, 'utf8')).toBe(TOKEN)
      expect(statSync(tokenFile).mode & 0o777).toBe(0o600)
      expect(statSync(sessionTokenDir()).mode & 0o777).toBe(0o700)
      // After a restricted launch's unset of the state .env, so nothing unsets it; before claude starts.
      expect(cmd.indexOf(SESSION_TOKEN_VAR)).toBeLessThan(cmd.indexOf('claude --'))
    })
  }
  test('no token, no step (a launch input from before tokens)', async () => {
    expect(await claudeCommand({ sessionToken: undefined })).not.toContain(SESSION_TOKEN_VAR)
  })
})

test('omp: by launch file, the same step', async () => {
  await new OmpEngine({} as any).launch({ ...base, model: 'claude-sonnet-5-5' } as any)
  const cmd = fake.calls().findLast(c => c.startsWith('new-session'))!
  expect(cmd).not.toContain(TOKEN)
  expect(cmd).toContain(`${SESSION_TOKEN_VAR}=$(cat '${tokenFile}') && export ${SESSION_TOKEN_VAR} && rm -f '${tokenFile}'`)
})

describe('Codex: in its app-server\'s environment', () => {
  test('the launch hands its token to the app-server\'s start', async () => {
    const starts: Array<{ sessionToken?: string }> = []
    const engine = { queueTurn: () => true, connect: async () => ({ threadId: 'th', model: 'm' }), disconnect: () => {}, isConnected: () => true }
    const proc = { registerMcp: () => {}, start: (o: { sessionToken?: string }) => { starts.push(o); return 1 }, stop: () => true }
    const adapter = codexAdapter(engine as any, proc as any) as any
    adapter.surface = () => null
    await adapter.launch({ ...base, model: 'm' })
    expect(starts.map(o => o.sessionToken)).toEqual([TOKEN])
  })
  test('its own token, not one it inherited', () => {
    const saved = process.env[SESSION_TOKEN_VAR]
    process.env[SESSION_TOKEN_VAR] = 'inherited-from-another-session'
    try {
      expect(codexSpawnEnv({ CODEX_HOME: '/tmp/h' }, { [SESSION_TOKEN_VAR]: TOKEN })[SESSION_TOKEN_VAR]).toBe(TOKEN)
      expect(codexSpawnEnv({ CODEX_HOME: '/tmp/h', [SESSION_TOKEN_VAR]: 'smuggled' })[SESSION_TOKEN_VAR]).toBeUndefined()
      expect(codexSpawnEnv()[SESSION_TOKEN_VAR]).toBeUndefined()

    } finally { if (saved === undefined) delete process.env[SESSION_TOKEN_VAR]; else process.env[SESSION_TOKEN_VAR] = saved }
  })
})

test('the pane\'s step, run by a shell: exports the token and removes the file; an unreadable file stops the chain', () => {
  const { load, path } = writeSessionToken('tok-t', SID, TOKEN)
  const out = execFileSync('sh', ['-c', `${load} && sh -c 'printf %s "$${SESSION_TOKEN_VAR}"'`], { encoding: 'utf8' })
  expect(out).toBe(TOKEN)   // exported: a child process (the hydra CLI) sees it
  expect(existsSync(path)).toBe(false)
  expect(() => execFileSync('sh', ['-c', `${load} && echo reached`], { encoding: 'utf8', stdio: 'pipe' })).toThrow()
})

test('a failed launch leaves no token file (removeLaunchFiles)', () => {
  const { path } = writeSessionToken('tok-t', SID, TOKEN)
  removeLaunchFiles({ tmuxName: 'tok-t', sessionId: SID })
  expect(existsSync(path)).toBe(false)
})

test('a fork asked a question is no session: it carries no token', () => {
  expect(askForkEnv({ PATH: '/bin', [SESSION_TOKEN_VAR]: TOKEN })[SESSION_TOKEN_VAR]).toBeUndefined()
})

describe('what the CLI says of its caller', () => {
  test('a token: presented', () => expect(callerClaim({ [SESSION_TOKEN_VAR]: TOKEN, HYDRA_SESSION_ID: 'x' })).toEqual({ token: TOKEN }))
  for (const v of ['HYDRA_SESSION_ID', 'HYDRA_SESSION_NAME', 'HYDRA_THREAD_ID', 'HYDRA_SESSION_TYPE', 'HYDRA_RESTRICTED', 'HYDRA_WRITE_CONFINED']) {
    test(`${v} alone: a session's environment without a token, never the operator`, () => expect(callerClaim({ [v]: '1' })).toEqual({ inSession: true }))
  }
  test('no hydra session variable (main\'s HYDRA_ROLE is not one): the operator\'s shell', () => {
    expect(callerClaim({ PATH: '/bin', HYDRA_ROLE: 'main', DAEMON_SOCK: '/s' })).toBeUndefined()
  })
})

test('every CLI request carries the claim (sendRequest, the CLI\'s one way to the daemon)', async () => {
  const { sendRequest } = await import('../../cli/helpers.js')
  const { createServer } = await import('net')
  const sock = join(mkdtempSync(join(tmpdir(), 'hydra-cli-claim-')), 's.sock')
  const got: Array<Record<string, unknown>> = []
  const server = createServer(c => c.on('data', d => { got.push(JSON.parse(String(d).trim())); c.end('{"ok":true}\n') }))
  await new Promise<void>(r => server.listen(sock, r))
  // Whatever session this test runs in, its identity is set aside: each call's environment is the case under test.
  const saved = Object.fromEntries(SESSION_IDENTITY_VARS.map(v => [v, process.env[v]]))
  try {
    for (const v of SESSION_IDENTITY_VARS) delete process.env[v]
    process.env[SESSION_TOKEN_VAR] = TOKEN
    await sendRequest(sock, { type: 'cli', command: 'list', id: '1', params: {} })
    delete process.env[SESSION_TOKEN_VAR]; process.env.HYDRA_SESSION_ID = 'x'
    await sendRequest(sock, { type: 'cli', command: 'list', id: '2', params: {} })
    delete process.env.HYDRA_SESSION_ID
    await sendRequest(sock, { type: 'cli', command: 'list', id: '3', params: {} })
  } finally {
    for (const [v, val] of Object.entries(saved)) { if (val === undefined) delete process.env[v]; else process.env[v] = val }
    server.close()
  }
  expect(got.map(r => r.caller)).toEqual([{ token: TOKEN }, { inSession: true }, undefined])
})
