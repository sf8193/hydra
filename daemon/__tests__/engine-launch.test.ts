import { describe, expect, test } from 'bun:test'
import { ClaudeAdapter, type ClaudeLaunchIo } from '../engines/claude-adapter.js'
import { CodexAdapter, type CodexLaunchIo } from '../engines/codex-adapter.js'
import type { EngineSpawnInput } from '../engines/engine-adapter.js'
import type { SessionInfo } from '../sessions.js'

const base = {
  sessionId: 'hydra-test-id', tmuxName: 'adapter-test', cwd: '/work/tree', originalCwd: '/work/main',
  model: 'test-model', prompt: "do the user's task", tools: ['Read'], disallowedTools: ['Write', 'Edit'],
}
const session: SessionInfo = {
  sessionId: base.sessionId, tmuxName: base.tmuxName, topic: 'test', threadId: 'chat',
  createdAt: 1, lastActive: 1, listening: false, sessionType: 'thread_owner',
}

function claude(failure?: string) {
  const calls: string[][] = []
  const adapter = new ClaudeAdapter({
    execFileSync: ((_bin: string, args: string[]) => {
      calls.push(args)
      if (args[0] === failure) throw new Error('injected failure')
      return Buffer.from('')
    }) as ClaudeLaunchIo['execFileSync'],
    mkdirSync: (() => undefined) as ClaudeLaunchIo['mkdirSync'],
    randomUUID: () => '00000000-0000-0000-0000-000000000001',
  })
  return { adapter, calls }
}

describe('Claude native launch — L06/L07/L08/L10/L13/L14', () => {
  test('failed stop of a live native session rejects', async () => {
    const { adapter, calls } = claude('kill-session')
    await expect(adapter.stop(session)).rejects.toThrow('still running')
    expect(calls.map(c => c[0])).toEqual(['kill-session', 'has-session'])
  })
  test('fresh launch sets identity, environment, restrictions and exit capture', async () => {
    const { adapter, calls } = claude()
    const result = await adapter.spawn({ ...base, mode: { kind: 'fresh' } })
    expect(calls.map(c => c[0])).toEqual(['new-session', 'has-session', 'pipe-pane'])
    const command = calls[0].at(-1)!
    expect(command).toContain("cd '/work/tree'")
    expect(command).toContain("export HYDRA_SESSION_ID='hydra-test-id'")
    expect(command).toContain("export HYDRA_SESSION_NAME='adapter-test'")
    expect(command).toContain('export DAEMON_SOCK=')
    expect(command).toContain('export CLAUDE_CONFIG_DIR=')
    expect(command).toContain('unset HYDRA_ROLE')
    expect(command).toContain("--session-id '00000000-0000-0000-0000-000000000001'")
    expect(command).toContain("--model 'test-model'")
    expect(command).toContain("--channels 'plugin:discord@claude-plugins-official'")
    expect(command).toContain("'do the user'\\''s task'")
    expect(command).toContain("--tools 'Read'")
    expect(command).toContain("--disallowedTools 'Write,Edit'")
    expect(command).toContain('trap _hydra_write_exit EXIT')
    expect(result.nativeIdentity?.sessionId).toBe('00000000-0000-0000-0000-000000000001')
    expect(result.exitFilePath).toContain('exit-adapter-test-hydra-test-id.log')
  })

  test('native fork starts from original cwd and supplies worktree instructions', async () => {
    const { adapter, calls } = claude()
    const result = await adapter.spawn({ ...base, worktreePath: base.cwd, forkFromOriginalCwd: true,
      mode: { kind: 'fork', source: { provider: 'claude', sessionId: 'parent-native-id' } } })
    const command = calls[0].at(-1)!
    expect(command).toContain("cd '/work/main'")
    expect(command).toContain("--resume 'parent-native-id' --fork-session")
    expect(command).toContain('WORKTREE: Your isolated worktree is at /work/tree.')
    // Characterize the existing fresh-only restriction flags, not presumed parity.
    expect(command).not.toContain('--disallowedTools')
    expect(command).not.toContain('--tools ')
    expect(result.nativeIdentity).toBeUndefined()
  })

  test('fork reusing a worktree preserves cwd and still includes its path', async () => {
    const { adapter, calls } = claude()
    await adapter.spawn({ ...base, worktreePath: base.cwd,
      mode: { kind: 'fork', source: { provider: 'claude', sessionId: 'parent-native-id' } } })
    const command = calls[0].at(-1)!
    expect(command).toContain("cd '/work/tree'")
    expect(command).toContain('WORKTREE: Your isolated worktree is at /work/tree.')
  })

  test('native resume restores history without sending a fresh prompt', async () => {
    const { adapter, calls } = claude()
    await adapter.spawn({ ...base, mode: { kind: 'resume', source: { provider: 'claude', sessionId: 'saved-id' } } })
    const command = calls[0].at(-1)!
    expect(command).toContain("--resume 'saved-id'")
    expect(command).not.toContain('--fork-session')
    expect(command).not.toContain('do the user')
    expect(command).not.toContain('--disallowedTools')
  })

  test('launch failure rejects before liveness probe or capture', async () => {
    const { adapter, calls } = claude('new-session')
    await expect(adapter.spawn({ ...base, mode: { kind: 'fresh' } })).rejects.toThrow('failed to spawn tmux session')
    expect(calls.map(c => c[0])).toEqual(['new-session'])
  })

  test('immediate process exit preserves current observational spawn result', async () => {
    const { adapter, calls } = claude('has-session')
    const result = await adapter.spawn({ ...base, mode: { kind: 'fresh' } })
    expect(calls.map(c => c[0])).toEqual(['new-session', 'has-session'])
    expect(result.spawnLogPath).toBeUndefined()
    expect(result.exitFilePath).toBeDefined()
  })

  test('capture failure is nonfatal', async () => {
    const { adapter } = claude('pipe-pane')
    const result = await adapter.spawn({ ...base, mode: { kind: 'fresh' } })
    expect(result.spawnLogPath).toBeUndefined()
    expect(result.nativeIdentity).toBeDefined()
  })
})

function codex(options: { live?: boolean; missingSource?: boolean; failConnect?: boolean } = {}) {
  const calls: string[] = []
  let now = 0
  const connected = async (kind: string) => {
    calls.push(kind)
    if (options.failConnect) throw new Error('not ready')
    return { threadId: 'native-thread', model: 'resolved-model' }
  }
  const io: CodexLaunchIo = {
    execFileSync: ((_bin: string, args: string[]) => { calls.push(`exec:${args.join(' ')}`); return Buffer.from('') }) as CodexLaunchIo['execFileSync'],
    existsSync: () => !options.missingSource,
    mkdirSync: (() => { calls.push('mkdir') }) as CodexLaunchIo['mkdirSync'],
    unlinkSync: () => { calls.push('unlink') }, cpSync: () => { calls.push('copy') },
    rmSync: () => { calls.push('remove') }, symlinkSync: () => { calls.push('symlink') },
    start: () => { calls.push('start'); return 123 }, stop: () => { calls.push('stop'); return true },
    now: () => now, wait: async ms => { now += ms },
  }
  const adapter = new CodexAdapter({
    isConnected: () => false, retireSession: async () => false, interruptPersistedThread: async () => false,
    isSocketLive: async () => { calls.push('probe'); return !!options.live },
    connect: () => connected('connect'), connectAndResume: () => connected('resume'),
    connectAndFork: () => connected('fork'), disconnect: () => { calls.push('disconnect') },
  }, io)
  return { adapter, calls }
}

const fork: EngineSpawnInput<'codex'> = { ...base,
  mode: { kind: 'fork', source: { provider: 'codex', threadId: 'parent-thread', homeName: 'parent-home' } } }

describe('Codex native launch — L08/L13/L16/L25', () => {
  test('stop waits for socket termination before touching the UI', async () => {
    const { adapter, calls } = codex({ live: true })
    await expect(adapter.stop({ ...session, engine: 'codex' })).rejects.toThrow('still shutting down')
    expect(calls.slice(0, 2)).toEqual(['disconnect', 'stop'])
    expect(calls.filter(c => c === 'probe').length).toBeGreaterThan(1)
    expect(calls.some(c => c.startsWith('exec:kill-session'))).toBe(false)
  })

  test('stop cleans the UI once the native server is terminal', async () => {
    const { adapter, calls } = codex()
    await adapter.stop({ ...session, engine: 'codex' })
    expect(calls).toEqual(['disconnect', 'stop', 'probe', `exec:kill-session -t ${base.tmuxName}`])
  })
  test('live destination rejects before any mutation', async () => {
    const { adapter, calls } = codex({ live: true })
    await expect(adapter.spawn(fork)).rejects.toThrow('refusing to replace live')
    expect(calls).toEqual(['probe'])
  })

  test('missing fork history rejects before destination mutation', async () => {
    const { adapter, calls } = codex({ missingSource: true })
    await expect(adapter.spawn(fork)).rejects.toThrow('source rollouts not found')
    expect(calls).toEqual(['probe'])
  })

  test('fork seeds isolated history before starting its own server', async () => {
    const { adapter, calls } = codex()
    const result = await adapter.spawn(fork)
    expect(calls.indexOf('probe')).toBeLessThan(calls.indexOf('remove'))
    expect(calls.indexOf('remove')).toBeLessThan(calls.indexOf('copy'))
    expect(calls.indexOf('copy')).toBeLessThan(calls.indexOf('start'))
    expect(calls.at(-1)).toBe('fork')
    expect(calls.find(c => c.startsWith('exec:mcp add'))).toContain('/daemon/codex-mcp-server.ts')
    expect(result.nativeIdentity).toEqual({ provider: 'codex', threadId: 'native-thread', homeName: base.tmuxName })
    expect(result.model).toBe('resolved-model')
  })

  test('resume retains the original home and thread', async () => {
    const { adapter, calls } = codex()
    const result = await adapter.spawn({ ...base,
      mode: { kind: 'resume', source: { provider: 'codex', threadId: 'saved-thread', homeName: 'saved-home' } } })
    expect(calls.at(-1)).toBe('resume')
    expect(calls).not.toContain('copy')
    expect(result.nativeIdentity).toEqual({ provider: 'codex', threadId: 'saved-thread', homeName: 'saved-home' })
  })

  test('fresh launch returns assigned persistent identity', async () => {
    const { adapter, calls } = codex()
    const result = await adapter.spawn({ ...base, mode: { kind: 'fresh' } })
    expect(calls.at(-1)).toBe('connect')
    expect(result.nativeIdentity?.threadId).toBe('native-thread')
  })

  test('startup timeout disconnects failed attempts and stops the owned server', async () => {
    const { adapter, calls } = codex({ failConnect: true })
    await expect(adapter.spawn({ ...base, mode: { kind: 'fresh' } })).rejects.toThrow('socket not ready after 15s')
    expect(calls.filter(c => c === 'connect')).toHaveLength(30)
    expect(calls.filter(c => c === 'disconnect')).toHaveLength(30)
    expect(calls.at(-1)).toBe('stop')
  })
})
