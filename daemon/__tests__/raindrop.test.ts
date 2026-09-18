import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { emit, getSubscriptions, on } from '../event-bus.js'
import {
  register,
  raindropState,
  resolveUserId,
  drivableBy,
  _TRACKED_MESSAGE_CAP,
  _setDeps,
  _resetDeps,
  _resetStateForTesting,
  _trackedSizeForTesting,
  post,
  factsFromRegistry,
  factsForMain,
  parseModelFlag,
  bytePaneArgv,
  raindropStatusLine,
  defaultAllowedUsers,
  defaultProjectFor,
  projectFromGitDir,
  defaultLiveSessionIds,
  type RaindropDeps,
  type RaindropMode,
} from '../raindrop.js'
import { EVENT_ENDPOINT, SIGNAL_ENDPOINT, type SessionFacts } from '../raindrop-payload.js'
import { mkdirSync, mkdtempSync, readFileSync, statSync, unlinkSync, writeFileSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { trimRaindropDryrun, startVitalsSnapshots } from '../observability.js'
import { registry, type SessionInfo } from '../sessions.js'
import { emitSessionDeath } from '../session-lifecycle.js'
import { PLATFORM, STATE_DIR, RAINDROP_DRYRUN_FILE } from '../config.js'
import { SCRUBBED_SPAWN_VARS, tmuxNewSession } from '../../shared/spawn-env.js'

const NOT_PLATFORM = 'fixture-not-a-platform'

const facts: SessionFacts = {
  threadId: 'THREAD-1',
  createdAt: 1789752921748,
  tmuxName: 'atlas',
  engine: 'claude',
  model: 'claude-opus-5[1m]',
  sessionType: 'thread_owner',
  originType: 'spawn',
  platform: 'slack',
  project: 'hydra',
}

const BYTE_PANE_CMD = "caffeinate -i claude --model 'claude-opus-5[1m]' --channels plugin:discord"

const NOW = 1789800000000

// body is the single element; raw is what actually went on the wire.
let sent: Array<{ endpoint: string; body: any; raw: any }>
const record = (endpoint: string, body: unknown) => { sent.push({ endpoint, body: (body as any[])[0], raw: body }) }
let stderr: string[]
let realStderr: typeof process.stderr.write
let dispose: () => void
const savedEnv: Record<string, string | undefined> = {}

function stubDeps(over: Partial<RaindropDeps> = {}): void {
  _setDeps({
    factsFor: (id) => (id === 'sess-1' ? facts : undefined),
    bytePaneCommand: () => BYTE_PANE_CMD,
    liveSessionIds: () => [],
    postEvent: async () => { throw new Error('postEvent must not run outside live mode') },
    recordDryRun: record,
    allowedUsers: () => new Set([DRIVER]),
    projectFor: (p) => p.split('/').pop(),
    env: () => process.env,
    now: () => NOW,
    ...over,
  })
}

beforeEach(() => {
  stderr = []
  realStderr = process.stderr.write
  process.stderr.write = ((chunk: string) => { stderr.push(String(chunk)); return true }) as typeof process.stderr.write
  for (const k of [...SCRUBBED_SPAWN_VARS, 'BYTE_SESSION_NAME']) savedEnv[k] = process.env[k]
  process.env.RAINDROP_MODE = 'dryrun'
  delete process.env.RAINDROP_WRITE_KEY
  delete process.env.RAINDROP_USER_ID
  delete process.env.RAINDROP_OMIT_REPO
  sent = []
  dispose = () => {}
  _resetStateForTesting()
  stubDeps()
})

afterEach(() => {
  dispose()
  process.stderr.write = realStderr
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  _resetDeps()
  _resetStateForTesting()
})

const DRIVER = 'U056CLXJY8P'
const tick = () => new Promise(r => setTimeout(r, 0))

function sinkFailingOnce(): () => void {
  let failNext = true
  stubDeps({
    recordDryRun: (endpoint, body) => {
      if (failNext) throw new Error('raindrop 503')
      record(endpoint, body)
    },
  })
  return () => { failNext = false }
}

async function reactWhileEventInFlight(): Promise<(ok: boolean) => void> {
  let settle: (ok: boolean) => void = () => {}
  stubDeps({
    postEvent: (endpoint, body) => new Promise<void>((resolve, reject) => {
      if (endpoint === SIGNAL_ENDPOINT) { record(endpoint, body); resolve(); return }
      settle = (ok) => ok ? resolve() : reject(new Error('raindrop 503'))
    }),
  })
  process.env.RAINDROP_MODE = 'live'
  process.env.RAINDROP_WRITE_KEY = 'rk_k'
  dispose = register()
  emit('reply', { sessionId: 'sess-1', text: 'x', chatId: 'THREAD-1', sentIds: ['msg-9'] })
  await tick()
  emit('reaction', { channelId: 'C', messageId: 'msg-9', userId: DRIVER, emoji: '-1' })
  await tick()
  return settle
}

function sessionInfo(over: Partial<SessionInfo> & { sessionId: string }): SessionInfo {
  return {
    threadId: 'T', tmuxName: 'x', engine: 'claude', sessionType: 'thread_owner',
    originType: 'spawn', createdAt: 1, lastActive: 1, listening: true, topic: '',
    ...over,
  }
}

function expectNoListenerErrors(): void {
  expect(stderr.filter(l => l.includes('daemon: raindrop:') && l.includes('failed'))).toEqual([])
}

describe('raindrop: mode', () => {
  test.each<[string | undefined, RaindropMode]>([
    [undefined, 'off'],
    ['off', 'off'],
    ['', 'off'],
    ['nonsense', 'off'],
    ['dryrun', 'dryrun'],
    ['DryRun', 'dryrun'],
    ['  dryrun  ', 'dryrun'],
    ['  DRYRUN  ', 'dryrun'],
  ])('RAINDROP_MODE=%p -> %s', (raw, expected) => {
    if (raw === undefined) delete process.env.RAINDROP_MODE
    else process.env.RAINDROP_MODE = raw
    expect(raindropState().active).toBe(expected)
  })

  test('live without a write key is off, not a silent dry-run', () => {
    process.env.RAINDROP_MODE = 'live'
    expect(raindropState().active).toBe('off')
  })

  test('a plain off boot warns about nothing', () => {
    process.env.RAINDROP_MODE = 'off'
    dispose = register()
    expect(stderr.join('')).toBe('')
  })

  test('an attributable boot does not warn', () => {
    dispose = register()
    expect(stderr.join('')).not.toContain('no attributable user')
    expect(stderr.join('')).not.toContain('disabled —')
  })

  test.each([
    ['a zero-width space', 'rd_live_\u200bDEADBEEF'],
    ['a newline', 'rd_live_\nDEADBEEF'],
    ['a carriage return', 'rd_live_\rDEADBEEF'],
    ['a NUL', 'rd_live_\0DEADBEEF'],
    ['a smart quote', 'rd_live_\u2019DEADBEEF'],
  ])('a write key with %s is refused, not sent', (_label, key) => {
    process.env.RAINDROP_MODE = 'live'
    process.env.RAINDROP_WRITE_KEY = key
    expect(raindropState().active).toBe('off')
    expect(raindropStatusLine('cli')).toContain('cannot go in an HTTP header')
    expect(raindropStatusLine('cli')).not.toContain('DEADBEEF')
    expect(() => new Headers({ Authorization: `Bearer ${key}` })).toThrow()
  })

  test('a padded write key is trimmed rather than refused', () => {
    process.env.RAINDROP_MODE = 'live'
    process.env.RAINDROP_WRITE_KEY = '  rk_realkey  '
    expect(raindropState().active).toBe('live')
  })

  test.each([undefined, '', '   ', 'off'])('a key on disk with mode %p is reported, not silently inert', (v) => {
    if (v === undefined) delete process.env.RAINDROP_MODE
    else process.env.RAINDROP_MODE = v
    process.env.RAINDROP_WRITE_KEY = 'rk_realkey'
    expect(raindropStatusLine('cli')).toContain('RAINDROP_MODE is off or unset, and RAINDROP_WRITE_KEY is still on disk')
  })

  test('no allowlisted user at all reads differently from too many to choose', () => {
    stubDeps({ allowedUsers: () => new Set() })
    expect(raindropStatusLine('cli')).toContain('no allowlisted user — nobody is paired')
    stubDeps({ allowedUsers: () => new Set(['U1', 'U2']) })
    expect(raindropStatusLine('cli')).toContain('no attributable user — set RAINDROP_USER_ID')
  })

  test('a leftover write key is named whatever shape the off state takes', () => {
    process.env.RAINDROP_WRITE_KEY = 'rk_realkey'
    for (const v of ['disabled', 'none', 'dry-run']) {
      process.env.RAINDROP_MODE = v
      expect(raindropStatusLine('cli'), v).toContain('RAINDROP_WRITE_KEY is still on disk')
    }
    delete process.env.RAINDROP_WRITE_KEY
    process.env.RAINDROP_MODE = 'disabled'
    expect(raindropStatusLine('cli')).not.toContain('still on disk')
  })

  test('an unrecognized mode is echoed only when it cannot be a write key', () => {
    process.env.RAINDROP_MODE = 'dry-run'
    expect(raindropStatusLine('cli')).toContain("unrecognized RAINDROP_MODE='dry-run'")
    process.env.RAINDROP_MODE = '00000000-0000-4000-8000-000000000000'
    expect(raindropStatusLine('cli')).toBe('disabled — unrecognized RAINDROP_MODE (expected off|dryrun|live)')
    // Long-but-alpha and short-but-alphanumeric each fail one half alone.
    process.env.RAINDROP_MODE = 'abcdefghijklmnopqrst'
    expect(raindropStatusLine('cli')).not.toContain('abcdefghijklmnopqrst')
    process.env.RAINDROP_MODE = 'rk1'
    expect(raindropStatusLine('cli')).not.toContain('rk1')
    process.env.RAINDROP_MODE = '1abc'
    expect(raindropStatusLine('cli')).not.toContain('1abc')
    process.env.RAINDROP_MODE = 'abcdefghijkl'
    expect(raindropStatusLine('cli')).toContain("'abcdefghijkl'")
    process.env.RAINDROP_MODE = 'abcdefghijklm'
    expect(raindropStatusLine('cli')).not.toContain('abcdefghijklm')
    process.env.RAINDROP_MODE = 'x'
    expect(raindropStatusLine('cli')).toContain("'x'")
  })

  test('dryrun with a usable key on disk stays dryrun and posts nothing', async () => {
    process.env.RAINDROP_WRITE_KEY = 'rk_realkey'
    expect(raindropState().active).toBe('dryrun')
    let posted = 0
    stubDeps({ postEvent: async () => { posted++ } })
    dispose = register()
    emit('reply', { sessionId: 'sess-1', text: 'x', chatId: 'THREAD-1', sentIds: ['m1'] })
    await tick()
    expect(posted).toBe(0)
    expect(sent).toHaveLength(1)
  })

  test('live with a write key is live', () => {
    process.env.RAINDROP_MODE = 'live'
    process.env.RAINDROP_WRITE_KEY = 'k'
    expect(raindropState().active).toBe('live')
  })
})

describe('raindrop: resolveUserId', () => {
  test('a single allowed user is unambiguous', () => {
    expect(resolveUserId(new Set(['U1']))).toBe('U1')
  })

  test('an unbounded channel group makes the owner unknowable', () => {
    expect(resolveUserId('unbounded')).toBe('')
  })

  test('refuses to guess an owner among several', () => {
    expect(resolveUserId(new Set(['U1', 'U2']))).toBe('')
  })

  test('an explicit id wins and disambiguates a multi-user install', () => {
    process.env.RAINDROP_USER_ID = '  U-explicit  '
    expect(resolveUserId(new Set(['U1', 'U2']))).toBe('U-explicit')
    expect(resolveUserId(new Set())).toBe('U-explicit')
  })

  test('no allowed users and no explicit id yields nothing', () => {
    expect(resolveUserId(new Set())).toBe('')
  })
})

describe('raindrop: the death event carries the time of death', () => {
  test('emitSessionDeath forwards deadAt, so the consumer is not guessing', async () => {
    const seen: any[] = []
    const off = on('session:death', (e) => { seen.push(e) }, 'test:deadAt-producer')
    try {
      emitSessionDeath(sessionInfo({
        sessionId: 's-dead', threadId: 'T-dead', tmuxName: 'atlas', deadAt: 1700,
      }))
      emitSessionDeath(sessionInfo({ sessionId: 's-live', threadId: 'T-live', tmuxName: 'atlas' }))
    } finally { off() }
    expect(seen.map(e => e.deadAt)).toEqual([1700, undefined])
    expect(seen[0].sessionId).toBe('s-dead')
  })
})

describe('raindrop: defaultProjectFor', () => {
  const git = (cwd: string, ...args: string[]) =>
    Bun.spawnSync(['git', ...args], { cwd, stdout: 'ignore', stderr: 'ignore' })

  test('a worktree and its checkout both report the project, not the directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'rd-proj-'))
    const repo = join(root, 'hydra')
    mkdirSync(repo)
    git(repo, 'init', '-q')
    git(repo, 'config', 'user.email', 't@t')
    git(repo, 'config', 'user.name', 't')
    writeFileSync(join(repo, 'f'), 'x')
    git(repo, 'add', '.')
    git(repo, 'commit', '-qm', 'init')
    const wt = join(root, 'hydra-atlas')
    git(repo, 'worktree', 'add', '-q', '--detach', wt)

    expect(defaultProjectFor(repo)).toBe('hydra')
    expect(defaultProjectFor(wt), 'a worktree must report its project').toBe('hydra')
  })

  test('a bare repo reports itself, not its parent directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'rd-bare-'))
    const bare = join(root, 'barerepo.git')
    Bun.spawnSync(['git', 'init', '-q', '--bare', bare], { stdout: 'ignore', stderr: 'ignore' })
    expect(defaultProjectFor(bare)).toBe('barerepo')
  })

  test('a submodule reports its own name, not "modules"', () => {
    const root = mkdtempSync(join(tmpdir(), 'rd-sub-'))
    const inner = join(root, 'inner')
    const outer = join(root, 'outer')
    for (const r of [inner, outer]) {
      mkdirSync(r)
      git(r, 'init', '-q')
      git(r, 'config', 'user.email', 't@t')
      git(r, 'config', 'user.name', 't')
      writeFileSync(join(r, 'f'), 'x')
      git(r, 'add', '.')
      git(r, 'commit', '-qm', 'init')
    }
    git(outer, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', inner, 'sub')
    // Every submodule on the machine would otherwise collapse into one bucket.
    expect(defaultProjectFor(join(outer, 'sub'))).toBe('sub')
  })

  test('a git binary that cannot be run reports nothing rather than throwing', () => {
    const real = Bun.spawnSync
    ;(Bun as unknown as { spawnSync: unknown }).spawnSync = () => {
      throw new Error('Executable not found in $PATH: "git"')
    }
    try {
      // register() calls this; a throw here leaves the daemon half-booted.
      expect(defaultProjectFor('/anywhere')).toBeUndefined()
    } finally {
      ;(Bun as unknown as { spawnSync: unknown }).spawnSync = real
    }
  })

  test.each([
    ['/x/plainrepo/.git', 'plainrepo'],
    ['/x/outer/.git/modules/sub', 'sub'],
    ['/x/outer/.git/modules/a/modules/b', 'b'],
    ['/x/barerepo.git', 'barerepo'],
  ])('projectFromGitDir(%p) -> %p', (common, want) => {
    expect(projectFromGitDir(common)).toBe(want)
  })

  test('a path that is not a git repo reports nothing rather than a directory name', () => {
    const plain = mkdtempSync(join(tmpdir(), 'rd-plain-'))
    expect(defaultProjectFor(plain)).toBeUndefined()
    expect(defaultProjectFor(join(plain, 'gone'))).toBeUndefined()
  })
})

describe('raindrop: a degraded tmux sweep surfaces on both interfaces', () => {
  // A pane that inherits the write key is the one failure the operator must
  // not have to find in stderr.
  function failingSweep(): void {
    const exec = ((_b: string, argv: string[]) => {
      if (argv[0] !== 'new-session') {
        throw Object.assign(new Error('boom'), { status: 2, stderr: 'server exploded' })
      }
      return ''
    }) as never
    const real = process.stderr.write
    process.stderr.write = (() => true) as typeof process.stderr.write
    try { tmuxNewSession(['-d', '-s', 'probe'], {}, exec) } finally { process.stderr.write = real }
  }

  test('slack/cli: hydra health names it instead of staying clean', async () => {
    dispose = register()
    expect(raindropStatusLine('cli')).not.toContain('sweep failure')
    failingSweep()
    await tick()
    expect(raindropStatusLine('cli')).toContain('1 tmux env sweep failure')
    expect(raindropStatusLine('cli')).toContain('a pane may hold the write key')
  })

  test('raindrop: it posts an event carrying a classified reason', async () => {
    dispose = register()
    failingSweep()
    await tick()
    const ev = sent.find(s => s.body.event === 'hydra.env.sweep_failed')
    expect(ev, 'no sweep event reached the sink').toBeTruthy()
    expect(ev!.endpoint).toBe(EVENT_ENDPOINT)
    // Classified, not the raw message — tmux errors quote the socket path.
    expect(ev!.body.properties.reason).toBe('exit-2')
    expect(JSON.stringify(ev!.body)).not.toContain('server exploded')
  })

  test('a cold start is neither counted nor reported', async () => {
    dispose = register()
    const exec = ((_b: string, argv: string[]) => {
      if (argv[0] !== 'new-session') {
        throw Object.assign(new Error('x'), { status: 1, stderr: 'no server running on /tmp/sock' })
      }
      return ''
    }) as never
    tmuxNewSession(['-d', '-s', 'probe'], {}, exec)
    await tick()
    expect(raindropStatusLine('cli')).not.toContain('sweep failure')
    expect(sent.find(s => s.body.event === 'hydra.env.sweep_failed')).toBeUndefined()
  })

  test('disposing unhooks it, so a later spawn does not report', async () => {
    dispose = register()
    dispose()
    dispose = () => {}
    failingSweep()
    await tick()
    expect(sent.find(s => s.body.event === 'hydra.env.sweep_failed')).toBeUndefined()
  })
})

describe('raindrop: wire shape', () => {
  test('both events and signals go as a one-element array', async () => {
    dispose = register()
    emit('reply', { sessionId: 'sess-1', text: 'x', chatId: 'THREAD-1', sentIds: ['m1'] })
    await tick()
    emit('reaction', { channelId: 'C', messageId: 'm1', userId: DRIVER, emoji: '-1' })
    await tick()

    const event = sent.find(s => s.endpoint === EVENT_ENDPOINT)!
    const signal = sent.find(s => s.endpoint === SIGNAL_ENDPOINT)!
    // Both endpoints take an array of one.
    expect(Array.isArray(event.raw)).toBe(true)
    expect(event.raw).toHaveLength(1)
    expect(Array.isArray(signal.raw)).toBe(true)
    expect(signal.raw).toHaveLength(1)
    expect('ai_data' in event.body).toBe(false)
  })

})

describe('raindrop: status', () => {
  test('a never-configured install reports nothing at all', () => {
    process.env.RAINDROP_MODE = 'off'
    expect(raindropStatusLine('cli')).toBeUndefined()
    expect(raindropStatusLine('chat')).toBeUndefined()
    delete process.env.RAINDROP_MODE
    expect(raindropStatusLine('cli')).toBeUndefined()
  })

  test('a misconfiguration is named, not silently off', () => {
    process.env.RAINDROP_MODE = 'live'
    expect(raindropStatusLine('cli')).toContain('RAINDROP_WRITE_KEY is unset')
    process.env.RAINDROP_MODE = 'dry-run'
    expect(raindropStatusLine('cli')).toContain("unrecognized RAINDROP_MODE='dry-run'")
  })

  test('dryrun names the file locally and only its basename in chat', () => {
    expect(raindropStatusLine('cli')).toBe(`dryrun → ${RAINDROP_DRYRUN_FILE} (nothing recorded yet)`)
    expect(raindropStatusLine('chat')).toBe('dryrun → raindrop-dryrun.jsonl (nothing recorded yet)')
    expect(raindropStatusLine('chat')).not.toContain('/')
  })

  test.each(['cli', 'chat'] as const)('live names the endpoint on the %s surface', (surface) => {
    process.env.RAINDROP_MODE = 'live'
    process.env.RAINDROP_WRITE_KEY = 'k'
    expect(raindropStatusLine(surface)).toBe('live → api.raindrop.ai (nothing recorded yet)')
  })

  test('a delivered event is visible, not just a failure', async () => {
    dispose = register()
    emit('session:bridge-registered', { sessionId: 'sess-1', threadId: 'THREAD-1' })
    await tick()
    expect(raindropStatusLine('cli')).toContain('1 recorded, last 0m ago')
  })

  test('RAINDROP_OMIT_REPO is reported, and a typo is named rather than ignored', () => {
    expect(raindropStatusLine('cli')).not.toContain('repo omitted')
    process.env.RAINDROP_OMIT_REPO = '1'
    expect(raindropStatusLine('cli')).toContain('repo omitted')
    expect(raindropStatusLine('cli')).not.toContain('RAINDROP_OMIT_REPO ignored')
    process.env.RAINDROP_OMIT_REPO = ''
    expect(raindropStatusLine('cli')).not.toContain('RAINDROP_OMIT_REPO ignored')
    process.env.RAINDROP_OMIT_REPO = 'true'
    expect(raindropStatusLine('cli')).toContain('repo omitted')
    expect(raindropStatusLine('cli')).toContain('RAINDROP_OMIT_REPO not understood — expected literal 1, repo omitted anyway')
    delete process.env.RAINDROP_OMIT_REPO
    expect(raindropStatusLine('cli')).not.toContain('RAINDROP_OMIT_REPO ignored')
  })

  test('a mistyped RAINDROP_OMIT_REPO is named at boot, not only on demand', () => {
    process.env.RAINDROP_OMIT_REPO = 'true'
    stubDeps({ allowedUsers: () => new Set(['U1', 'U2']) })
    dispose = register()
    expect(stderr.join('')).toBe(
      `daemon: raindrop: dryrun → ${RAINDROP_DRYRUN_FILE} (RAINDROP_OMIT_REPO not understood — expected literal 1, repo omitted anyway; ` +
      'no attributable user — set RAINDROP_USER_ID; nothing recorded yet)\n',
    )
  })

  test('an unbounded install stops nagging once an owner is pinned', () => {
    stubDeps({ allowedUsers: () => 'unbounded' })
    expect(raindropStatusLine('cli')).toContain('no attributable user')
    process.env.RAINDROP_USER_ID = 'U-owner'
    expect(raindropStatusLine('cli')).not.toContain('no attributable user')
  })

  test('an owner who is not an allowlisted driver is named, not silently broken', () => {
    process.env.RAINDROP_USER_ID = 'U-typo'
    stubDeps({ allowedUsers: () => new Set(['U-owner', 'U-dana']) })
    expect(raindropStatusLine('cli')).toContain('RAINDROP_USER_ID=U-typo is not an allowlisted user')
  })

  test('an owner who is a driver draws no complaint', () => {
    process.env.RAINDROP_USER_ID = 'U-owner'
    stubDeps({ allowedUsers: () => new Set(['U-owner', 'U-dana']) })
    expect(raindropStatusLine('cli')).not.toContain('not an allowlisted user')
  })

  test('an unbounded install cannot check the owner, so it does not complain', () => {
    process.env.RAINDROP_USER_ID = 'U-owner'
    stubDeps({ allowedUsers: () => 'unbounded' })
    expect(raindropStatusLine('cli')).not.toContain('not an allowlisted user')
  })

  test('dryrun calls a local write failure an error, not a send failure', async () => {
    stubDeps({ recordDryRun: () => { throw new Error('ENOSPC') } })
    dispose = register()
    emit('session:bridge-registered', { sessionId: 'sess-1', threadId: 'THREAD-1' })
    await tick()
    expect(raindropStatusLine('cli')).toContain('1 write error')
    expect(raindropStatusLine('cli')).not.toContain('send failure')
    // The log has to use the same word health does, or the documented grep misses.
    expect(stderr.join('')).toMatch(/daemon: raindrop: write failed \(1\): (Error: )?ENOSPC/)
    expect(stderr.join('')).toContain('raindrop.test.ts:')
  })

  test('reports suppression alongside the counters, not instead of them', async () => {
    dispose = register()
    emit('session:bridge-registered', { sessionId: 'sess-1', threadId: 'THREAD-1' })
    await tick()
    // The history an operator is debugging must survive an attribution lapse.
    stubDeps({ allowedUsers: () => 'unbounded' })
    const line = raindropStatusLine('cli')!
    expect(line).toContain('no attributable user')
    expect(line).toContain('1 recorded, last 0m ago')
    stubDeps({ allowedUsers: () => new Set(['U1', 'U2']) })
    expect(raindropStatusLine('cli')).toContain('no attributable user')
  })

  test('counts send failures and how long ago the last one was', async () => {
    process.env.RAINDROP_MODE = 'live'
    process.env.RAINDROP_WRITE_KEY = 'k'
    let clock = NOW
    stubDeps({ postEvent: async () => { throw new Error('raindrop 500') }, now: () => clock })
    dispose = register()
    emit('session:bridge-registered', { sessionId: 'sess-1', threadId: 'THREAD-1' })
    await tick()
    clock = NOW + 60_000
    expect(raindropStatusLine('cli')).toBe('live → api.raindrop.ai (nothing recorded yet; 1 send failure, last 1m ago)')
    // Advance, never rewind — a frozen lastFailureAt passes a rewound clock.
    clock = NOW + 300_000
    emit('reply', { sessionId: 'sess-1', text: 'x', chatId: 'C', sentIds: ['m'] })
    await tick()
    clock = NOW + 360_000
    expect(raindropStatusLine('cli')).toBe('live → api.raindrop.ai (nothing recorded yet; 2 send failures, last 1m ago)')
    expect(stderr.join('')).toContain('daemon: raindrop: send failed (1):')
  })
})

describe('raindrop: registration', () => {
  test('off mode subscribes to nothing', () => {
    process.env.RAINDROP_MODE = 'off'
    dispose = register()
    expect(Object.values(getSubscriptions()).flat().filter(l => l.startsWith('raindrop:'))).toEqual([])
  })

  test('enabled mode subscribes with distinctive labels', () => {
    dispose = register()
    const labels = Object.values(getSubscriptions()).flat().filter(l => l.startsWith('raindrop:'))
    expect(labels.sort()).toEqual([
      'raindrop:death', 'raindrop:reaction-signal', 'raindrop:reply', 'raindrop:spawn',
    ])
  })

  test('the disposer removes every listener it added', () => {
    const before = Object.values(getSubscriptions()).flat().length
    const off = register()
    off()
    expect(Object.values(getSubscriptions()).flat().length).toBe(before)
    expect(Object.values(getSubscriptions()).flat().filter(l => l.startsWith('raindrop:'))).toEqual([])
  })
})

describe('raindrop: events', () => {
  test('first bridge registration reports a spawn stamped with createdAt', async () => {
    dispose = register()
    emit('session:bridge-registered', { sessionId: 'sess-1', threadId: 'THREAD-1' })
    await tick()
    expect(sent).toHaveLength(1)
    expect(sent[0].endpoint).toBe(EVENT_ENDPOINT)
    expect(sent[0].body.event).toBe('hydra.session.spawn')
    expect(sent[0].body.event_id).toBe('sess-1')
    expect(sent[0].body.properties.threadId).toBe('THREAD-1')
    // Not deps.now() — a daemon restart must re-report the same instant.
    expect(sent[0].body.timestamp).toBe(new Date(facts.createdAt).toISOString())
    expectNoListenerErrors()
  })

  test('reconnects are idempotent — a bridge flap sends one spawn', async () => {
    dispose = register()
    for (let i = 0; i < 5; i++) {
      emit('session:bridge-registered', { sessionId: 'sess-1', threadId: 'THREAD-1' })
    }
    await tick()
    expect(sent).toHaveLength(1)
  })

  test('reconnect refreshes the cached facts, so death reports the current tmuxName', async () => {
    const recovered = { ...facts, tmuxName: 'reborn' }
    let current = facts
    stubDeps({ factsFor: () => current })
    dispose = register()
    emit('session:bridge-registered', { sessionId: 'sess-1', threadId: 'THREAD-1' })
    await tick()
    current = recovered
    emit('session:bridge-registered', { sessionId: 'sess-1', threadId: 'THREAD-1' })
    await tick()
    stubDeps({ factsFor: () => undefined })
    emit('session:death', { sessionId: 'sess-1', threadId: 'THREAD-1', wasOwner: true, tmuxName: 'reborn' })
    await tick()
    const death = sent.find(s => s.body.event === 'hydra.session.death')!
    expect(death.body.properties.tmuxName).toBe('reborn')
  })

  test('a reply refreshes the cached facts, so death reports the current role', async () => {
    let current: SessionFacts = { ...facts, sessionType: 'factory_builder' }
    stubDeps({ factsFor: () => current })
    dispose = register()
    emit('session:bridge-registered', { sessionId: 'sess-1', threadId: 'THREAD-1' })
    await tick()
    current = { ...facts, sessionType: 'thread_owner' }
    emit('reply', { sessionId: 'sess-1', text: 'a', chatId: 'THREAD-1', sentIds: ['msg-1'] })
    await tick()
    stubDeps({ factsFor: () => undefined })
    emit('session:death', { sessionId: 'sess-1', threadId: 'THREAD-1', wasOwner: true, tmuxName: 'atlas' })
    await tick()
    const death = sent.find(s => s.body.event === 'hydra.session.death')!
    expect(death.body.properties.sessionType).toBe('thread_owner')
  })

  test('death is stamped when the session died, not when it was reclaimed', async () => {
    dispose = register()
    emit('session:bridge-registered', { sessionId: 'sess-1', threadId: 'THREAD-1' })
    await tick()
    sent.length = 0
    const diedAt = NOW - 4 * 60 * 60_000
    emit('session:death', {
      sessionId: 'sess-1', threadId: 'THREAD-1', wasOwner: true, tmuxName: 'atlas', deadAt: diedAt,
    })
    await tick()
    expect(sent[0].body.timestamp).toBe(new Date(diedAt).toISOString())
  })

  test('a death with no deadAt falls back to now', async () => {
    dispose = register()
    emit('session:bridge-registered', { sessionId: 'sess-1', threadId: 'THREAD-1' })
    await tick()
    sent.length = 0
    emit('session:death', { sessionId: 'sess-1', threadId: 'THREAD-1', wasOwner: true, tmuxName: 'atlas' })
    await tick()
    expect(sent[0].body.timestamp).toBe(new Date(NOW).toISOString())
  })

  test('the reported repo is the project, resolved from the worktree path', async () => {
    const seen: string[] = []
    registry.set('wt-1', sessionInfo({
      sessionId: 'wt-1', threadId: 'T-W', tmuxName: 'atlas', createdAt: 5, lastActive: 5,
      worktreeRepo: '/Users/kevin/RubymineProjects/.worktrees/hydra-atlas',
    }))
    stubDeps({
      factsFor: factsFromRegistry,
      projectFor: (p) => { seen.push(p); return 'hydra' },
    })
    dispose = register()
    emit('session:bridge-registered', { sessionId: 'wt-1', threadId: 'T-W' })
    await tick()
    registry.delete('wt-1')
    expect(seen).toEqual(['/Users/kevin/RubymineProjects/.worktrees/hydra-atlas'])
    expect(sent[0].body.properties.repo).toBe('hydra')
  })

  test('the project lookup is memoised per path, not run per event', async () => {
    let calls = 0
    registry.set('wt-2', sessionInfo({
      sessionId: 'wt-2', threadId: 'T-W2', tmuxName: 'atlas', createdAt: 5, lastActive: 5,
      worktreeRepo: '/repos/alpha',
    }))
    stubDeps({ factsFor: factsFromRegistry, projectFor: () => { calls++; return 'alpha' } })
    dispose = register()
    emit('session:bridge-registered', { sessionId: 'wt-2', threadId: 'T-W2' })
    await tick()
    emit('reply', { sessionId: 'wt-2', text: 'x', chatId: 'T-W2', sentIds: ['m1'] })
    await tick()
    registry.delete('wt-2')
    expect(calls).toBe(1)
  })

  test('a failed project lookup is retried on a bound, not remembered as "no repo"', async () => {
    let calls = 0
    registry.set('wt-3', sessionInfo({
      sessionId: 'wt-3', threadId: 'T-W3', tmuxName: 'atlas', createdAt: 5, lastActive: 5,
      worktreeRepo: '/repos/beta',
    }))
    stubDeps({
      factsFor: factsFromRegistry,
      projectFor: () => { calls++; return calls === 1 ? undefined : 'beta' },
    })
    dispose = register()
    emit('session:bridge-registered', { sessionId: 'wt-3', threadId: 'T-W3' })
    await tick()
    expect('repo' in sent[0].body.properties).toBe(false)
    // Within the retry bound the daemon must not fork git again.
    emit('reply', { sessionId: 'wt-3', text: 'x', chatId: 'T-W3', sentIds: ['m1'] })
    await tick()
    expect(calls).toBe(1)
    expect('repo' in sent[1].body.properties).toBe(false)
    stubDeps({
      factsFor: factsFromRegistry,
      projectFor: () => { calls++; return 'beta' },
      now: () => NOW + 61_000,
    })
    emit('reply', { sessionId: 'wt-3', text: 'x', chatId: 'T-W3', sentIds: ['m2'] })
    await tick()
    registry.delete('wt-3')
    expect(sent[2].body.properties.repo).toBe('beta')
  })

  test.each(['1', 'true', 'yes', '0'])('RAINDROP_OMIT_REPO=%p keeps the repo off the wire', async (v) => {
    process.env.RAINDROP_OMIT_REPO = v
    dispose = register()
    emit('session:bridge-registered', { sessionId: 'sess-1', threadId: 'THREAD-1' })
    await tick()
    expect('repo' in sent[0].body.properties, v).toBe(false)
  })

  test('an unset RAINDROP_OMIT_REPO reports the repo', async () => {
    delete process.env.RAINDROP_OMIT_REPO
    dispose = register()
    emit('session:bridge-registered', { sessionId: 'sess-1', threadId: 'THREAD-1' })
    await tick()
    expect(sent[0].body.properties.repo).toBe('hydra')
  })

  test('a session that dies without an event is swept, not leaked', async () => {
    let live = ['sess-1']
    stubDeps({ liveSessionIds: () => live })
    const realSetInterval = globalThis.setInterval
    let onSweep: (() => void) | undefined
    globalThis.setInterval = ((fn: () => void) => { onSweep = fn; return { unref() {} } }) as unknown as typeof setInterval
    try { dispose = register() } finally { globalThis.setInterval = realSetInterval }
    emit('session:bridge-registered', { sessionId: 'sess-1', threadId: 'THREAD-1' })
    await tick()
    expect(_trackedSizeForTesting()).toBe(1)
    // A crash detector sets deadAt and emits nothing; the registry is the truth.
    live = []
    onSweep!()
    expect(_trackedSizeForTesting()).toBe(0)
  })

  test('a reply landing after the death does not resurrect the entry for good', async () => {
    let live = ['sess-1']
    stubDeps({ liveSessionIds: () => live })
    const realSetInterval = globalThis.setInterval
    let onSweep: (() => void) | undefined
    globalThis.setInterval = ((fn: () => void) => { onSweep = fn; return { unref() {} } }) as unknown as typeof setInterval
    try { dispose = register() } finally { globalThis.setInterval = realSetInterval }
    emit('session:bridge-registered', { sessionId: 'sess-1', threadId: 'THREAD-1' })
    await tick()
    emit('session:death', { sessionId: 'sess-1', threadId: 'THREAD-1', wasOwner: true, tmuxName: 'atlas' })
    await tick()
    emit('reply', { sessionId: 'sess-1', text: 'late', chatId: 'THREAD-1', sentIds: ['m1'] })
    await tick()
    expect(_trackedSizeForTesting(), 'the late reply re-added it').toBe(1)
    live = []
    onSweep!()
    expect(_trackedSizeForTesting(), 'and the sweep reclaims it').toBe(0)
  })

  test('an unresolvable registration does not suppress a later spawn', async () => {
    let resolvable = false
    stubDeps({ factsFor: () => (resolvable ? facts : undefined) })
    dispose = register()
    emit('session:bridge-registered', { sessionId: 'sess-1', threadId: 'THREAD-1' })
    await tick()
    expect(sent).toEqual([])
    resolvable = true
    emit('session:bridge-registered', { sessionId: 'sess-1', threadId: 'THREAD-1' })
    await tick()
    expect(sent.map(s => s.body.event)).toEqual(['hydra.session.spawn'])
  })

  test('death reports from cached facts — the registry entry is already gone', async () => {
    stubDeps({ factsFor: (id) => (id === 'sess-1' ? facts : undefined) })
    dispose = register()
    emit('session:bridge-registered', { sessionId: 'sess-1', threadId: 'THREAD-1' })
    await tick()
    stubDeps({ factsFor: () => undefined })
    emit('session:death', { sessionId: 'sess-1', threadId: 'THREAD-1', wasOwner: true, tmuxName: 'atlas' })
    await tick()
    expect(sent.map(s => s.body.event)).toEqual(['hydra.session.spawn', 'hydra.session.death'])
    expect(sent[1].body.event_id).toBe('sess-1:death')
    expect(sent[1].body.properties.tmuxName).toBe('atlas')
    expect(sent[1].body.timestamp).toBe(new Date(NOW).toISOString())
    expectNoListenerErrors()
  })

  test('death for a session never registered sends nothing', async () => {
    dispose = register()
    emit('session:death', { sessionId: 'ghost', threadId: 'T', wasOwner: true, tmuxName: 'x' })
    await tick()
    expect(sent).toEqual([])
    expectNoListenerErrors()
  })

  test('reply is keyed on the last chunk and carries a length, not text', async () => {
    dispose = register()
    emit('reply', { sessionId: 'sess-1', text: 'secret wire details', chatId: 'THREAD-1', sentIds: ['c1', 'c2', 'msg-9'] })
    await tick()
    expect(sent[0].body.event_id).toBe('msg-9')
    expect(sent[0].body.properties.replyChars).toBe(19)
    expect(sent[0].body.timestamp).toBe(new Date(NOW).toISOString())
    expect(JSON.stringify(sent[0].body)).not.toContain('secret')
  })

  test('threadId is the session thread, not the caller-supplied chat_id', async () => {
    dispose = register()
    emit('reply', { sessionId: 'sess-1', text: 'x', chatId: 'C0B6KKFNH4N:1779979488.572029', sentIds: ['m'] })
    await tick()
    expect(sent[0].body.properties.threadId).toBe(facts.threadId)
  })

  test('a reply that never sent still reports, keyed on session and time', async () => {
    dispose = register()
    emit('reply', { sessionId: 'sess-1', text: 'hi', chatId: 'THREAD-1', sentIds: [] })
    await tick()
    expect(sent[0].body.event_id).toBe(`sess-1:${NOW}`)
  })

  test('an unknown or headless session produces no event', async () => {
    dispose = register()
    emit('reply', { sessionId: 'ghost', text: 'x', chatId: 'c', sentIds: ['m'] })
    emit('session:bridge-registered', { sessionId: 'ghost', threadId: 't' })
    await tick()
    expect(sent).toEqual([])
    expectNoListenerErrors()
  })

  test('no resolvable user id means no egress', async () => {
    stubDeps({ allowedUsers: () => new Set(['U1', 'U2']) })
    dispose = register()
    emit('session:bridge-registered', { sessionId: 'sess-1', threadId: 'THREAD-1' })
    await tick()
    expect(sent).toEqual([])
  })
})

describe('raindrop: main session', () => {
  test('main replies are instrumented despite having no registry entry', async () => {
    dispose = register()
    emit('reply', { sessionId: 'main', text: 'answer', chatId: 'D0BE-MAIN', sentIds: ['msg-main'] })
    await tick()
    expect(sent).toHaveLength(1)
    expect(sent[0].body.event_id).toBe('msg-main')
    expect(sent[0].body.properties).toEqual({
      tmuxName: 'main',
      engine: 'claude',
      sessionType: 'master_orchestrator',
      threadId: 'D0BE-MAIN',
      model: 'claude-opus-5[1m]',
      platform: PLATFORM,
      replyChars: 6,
    })
    expect(sent[0].body.properties.model).toBe('claude-opus-5[1m]')
    expect(sent[0].body.properties.threadId).toBe('D0BE-MAIN')
  })

  test("main's threadId follows the chat it replied to", async () => {
    dispose = register()
    emit('reply', { sessionId: 'main', text: 'a', chatId: 'CHAT-A', sentIds: ['m1'] })
    emit('reply', { sessionId: 'main', text: 'b', chatId: 'CHAT-B', sentIds: ['m2'] })
    await tick()
    expect(sent.map(s => s.body.properties.threadId)).toEqual(['CHAT-A', 'CHAT-B'])
  })

  test('main produces no spawn or death event — it has no such lifecycle', async () => {
    dispose = register()
    emit('session:bridge-registered', { sessionId: 'main', threadId: 'C' })
    emit('session:death', { sessionId: 'main', threadId: 'C', wasOwner: false, tmuxName: 'main' })
    await tick()
    expect(sent).toEqual([])
    expectNoListenerErrors()
  })
})

describe('raindrop: reaction signals', () => {
  async function replyThen(sentIds: string[]): Promise<void> {
    emit('reply', { sessionId: 'sess-1', text: 'a', chatId: 'THREAD-1', sentIds })
    await tick()
    sent.length = 0
  }

  test('thumbs down on a tracked reply becomes a negative signal', async () => {
    dispose = register()
    await replyThen(['msg-9'])
    emit('reaction', { channelId: 'C1', messageId: 'msg-9', userId: DRIVER, emoji: '-1' })
    await tick()
    expect(sent).toHaveLength(1)
    expect(sent[0].endpoint).toBe(SIGNAL_ENDPOINT)
    expect(sent[0].raw).toEqual(
      [{ event_id: 'msg-9', signal_name: 'thumbs_down', signal_type: 'default', sentiment: 'NEGATIVE' }],
    )
  })

  test('a reaction on any chunk resolves to the reply event', async () => {
    dispose = register()
    await replyThen(['c1', 'c2', 'c3'])
    emit('reaction', { channelId: 'C1', messageId: 'c1', userId: DRIVER, emoji: '👎' })
    await tick()
    expect(sent[0].body.event_id).toBe('c3')
  })

  test('a reaction on a message hydra never sent is dropped', async () => {
    dispose = register()
    await replyThen(['msg-9'])
    emit('reaction', { channelId: 'C1', messageId: 'a-colleagues-message', userId: DRIVER, emoji: '+1' })
    await tick()
    expect(sent).toEqual([])
    expectNoListenerErrors()
  })

  test('an unrelated reaction on a tracked reply sends nothing', async () => {
    dispose = register()
    await replyThen(['msg-9'])
    emit('reaction', { channelId: 'C1', messageId: 'msg-9', userId: DRIVER, emoji: 'hocho' })
    emit('reaction', { channelId: 'C1', messageId: 'msg-9', userId: DRIVER, emoji: 'eyes' })
    await tick()
    expect(sent).toEqual([])
    expectNoListenerErrors()
  })

  test('an unbounded install records the owner\'s own reaction and nobody else\'s', async () => {
    process.env.RAINDROP_USER_ID = 'U-owner'
    stubDeps({ allowedUsers: () => 'unbounded' })
    dispose = register()
    emit('reply', { sessionId: 'sess-1', text: 'a', chatId: 'THREAD-1', sentIds: ['msg-9'] })
    await tick()
    expect(sent.map(s => s.endpoint)).toEqual([EVENT_ENDPOINT])
    sent.length = 0
    emit('reaction', { channelId: 'C1', messageId: 'msg-9', userId: 'U-any-member', emoji: '👎' })
    await tick()
    expect(sent).toEqual([])
    emit('reaction', { channelId: 'C1', messageId: 'msg-9', userId: 'U-owner', emoji: '👎' })
    await tick()
    expect(sent.map(s => s.endpoint)).toEqual([SIGNAL_ENDPOINT])
    expectNoListenerErrors()
  })

  test('a second driver is not the attributed user, and their reaction is dropped', async () => {
    process.env.RAINDROP_USER_ID = 'U-owner'
    stubDeps({ allowedUsers: () => new Set(['U-owner', 'U-dana']) })
    dispose = register()
    await replyThen(['msg-9'])
    for (const userId of ['U-dana', 'U-outsider']) {
      emit('reaction', { channelId: 'C1', messageId: 'msg-9', userId, emoji: '-1' })
      await tick()
      expect(sent, userId).toEqual([])
    }
    emit('reaction', { channelId: 'C1', messageId: 'msg-9', userId: 'U-owner', emoji: '-1' })
    await tick()
    expect(sent.map(s => s.endpoint)).toEqual([SIGNAL_ENDPOINT])
  })

  test('a failed signal send is retryable, not suppressed forever', async () => {
    let failSignal = true
    stubDeps({
      recordDryRun: (endpoint, body) => {
        if (endpoint === SIGNAL_ENDPOINT && failSignal) throw new Error('raindrop 503')
        record(endpoint, body)
      },
    })
    dispose = register()
    await replyThen(['msg-9'])
    emit('reaction', { channelId: 'C1', messageId: 'msg-9', userId: DRIVER, emoji: '-1' })
    await tick()
    expect(sent, 'the failed signal must not be recorded').toEqual([])
    failSignal = false
    emit('reaction', { channelId: 'C1', messageId: 'msg-9', userId: DRIVER, emoji: '-1' })
    await tick()
    expect(sent.map(s => s.endpoint), 'reacting again must retry').toEqual([SIGNAL_ENDPOINT])
  })

  test('the same reaction twice records one signal, not two', async () => {
    stubDeps({ allowedUsers: () => new Set([DRIVER]) })
    dispose = register()
    await replyThen(['msg-9', 'msg-10'])
    for (const messageId of ['msg-9', 'msg-9', 'msg-10']) {
      emit('reaction', { channelId: 'C1', messageId, userId: DRIVER, emoji: '-1' })
      await tick()
    }
    expect(sent.map(s => s.endpoint)).toEqual([SIGNAL_ENDPOINT])
    emit('reaction', { channelId: 'C1', messageId: 'msg-9', userId: DRIVER, emoji: '+1' })
    await tick()
    expect(sent).toHaveLength(2)
  })

  test('a group added after the reply stops signals for that reply', async () => {
    dispose = register()
    emit('reply', { sessionId: 'sess-1', text: 'a', chatId: 'THREAD-1', sentIds: ['msg-9'] })
    await tick()
    expect(sent).toHaveLength(1)
    sent.length = 0
    stubDeps({ allowedUsers: () => 'unbounded' })
    emit('reaction', { channelId: 'C1', messageId: 'msg-9', userId: DRIVER, emoji: '-1' })
    await tick()
    expect(sent).toEqual([])
  })

  test('attribution lost after a delivered reply stops the signal on it', async () => {
    let drivers = new Set(['U1'])
    stubDeps({ allowedUsers: () => drivers })
    dispose = register()
    emit('reply', { sessionId: 'sess-1', text: 'a', chatId: 'THREAD-1', sentIds: ['msg-9'] })
    await tick()
    expect(sent).toHaveLength(1)
    sent.length = 0
    drivers = new Set(['U1', 'U2'])
    emit('reaction', { channelId: 'C1', messageId: 'msg-9', userId: 'U1', emoji: '-1' })
    await tick()
    expect(sent).toEqual([])
    expectNoListenerErrors()
  })
})

describe('raindrop: drivableBy', () => {
  test('folds channel groups in alongside the DM allowlist', () => {
    expect(drivableBy({ allowFrom: ['U1'], groups: { C1: { allowFrom: ['U2'] } } })).toEqual(new Set(['U1', 'U2']))
  })

  test('a group with an empty allowFrom admits anyone, so the owner is unbounded', () => {
    expect(drivableBy({ allowFrom: ['U1'], groups: { C1: { allowFrom: [] } } })).toBe('unbounded')
    expect(drivableBy({ allowFrom: ['U1'], groups: { C1: {} } })).toBe('unbounded')
  })

  test('the documented single-user install with no groups stays attributable', () => {
    expect(resolveUserId(drivableBy({ allowFrom: ['U1'], groups: {} }))).toBe('U1')
  })

  test('a colleague reachable through a channel blocks attribution', () => {
    expect(resolveUserId(drivableBy({ allowFrom: ['U1'], groups: { C1: { allowFrom: ['U-dana'] } } }))).toBe('')
  })
})

describe('raindrop: bounded message map', () => {
  /** Does a reaction on this id still resolve to a signal? */
  async function resolves(messageId: string): Promise<boolean> {
    sent.length = 0
    emit('reaction', { channelId: 'C', messageId, userId: DRIVER, emoji: '-1' })
    await tick()
    return sent.length > 0
  }

  async function fillToCap(): Promise<void> {
    for (let i = 0; i < _TRACKED_MESSAGE_CAP; i++) {
      emit('reply', { sessionId: 'sess-1', text: 'a', chatId: 'T', sentIds: [`m${i}`] })
    }
    await tick()
  }

  test('one insert past the cap evicts exactly the oldest', async () => {
    dispose = register()
    emit('reply', { sessionId: 'sess-1', text: 'a', chatId: 'T', sentIds: ['oldest'] })
    await tick()
    await fillToCap()
    expect(await resolves('oldest')).toBe(false)
    expect(await resolves('m0')).toBe(true)
    expect(await resolves(`m${_TRACKED_MESSAGE_CAP - 1}`)).toBe(true)
  })

  test('a chunked reply past the cap evicts one id per id added', async () => {
    dispose = register()
    await fillToCap()
    emit('reply', { sessionId: 'sess-1', text: 'x', chatId: 'T', sentIds: ['k1', 'k2', 'k3', 'k4', 'k5'] })
    await tick()
    for (const evicted of ['m0', 'm1', 'm2', 'm3', 'm4']) {
      expect(await resolves(evicted)).toBe(false)
    }
    expect(await resolves('m5')).toBe(true)
    expect(await resolves('k5')).toBe(true)
  })
})

describe('raindrop: death bookkeeping', () => {
  test('a second death for the same session sends nothing', async () => {
    dispose = register()
    emit('session:bridge-registered', { sessionId: 'sess-1', threadId: 'THREAD-1' })
    await tick()
    sent.length = 0
    for (let i = 0; i < 3; i++) {
      emit('session:death', { sessionId: 'sess-1', threadId: 'THREAD-1', wasOwner: true, tmuxName: 'atlas' })
    }
    await tick()
    expect(sent.map(s => s.body.event)).toEqual(['hydra.session.death'])
  })

  test('a sessionId reappearing after death reports a fresh spawn', async () => {
    dispose = register()
    emit('session:bridge-registered', { sessionId: 'sess-1', threadId: 'THREAD-1' })
    await tick()
    emit('session:death', { sessionId: 'sess-1', threadId: 'THREAD-1', wasOwner: true, tmuxName: 'atlas' })
    await tick()
    sent.length = 0
    emit('session:bridge-registered', { sessionId: 'sess-1', threadId: 'THREAD-1' })
    await tick()
    expect(sent.map(s => s.body.event)).toEqual(['hydra.session.spawn'])
  })
})

describe('raindrop: correlation only after a successful send', () => {
  test('a reaction on a reply whose event never landed sends no signal', async () => {
    const recover = sinkFailingOnce()
    dispose = register()
    emit('reply', { sessionId: 'sess-1', text: 'x', chatId: 'THREAD-1', sentIds: ['gone-1'] })
    await tick()
    expect(sent).toEqual([])
    recover()
    emit('reaction', { channelId: 'C', messageId: 'gone-1', userId: DRIVER, emoji: '-1' })
    await tick()
    expect(sent).toEqual([])
  })

  test('a reaction in flight sends nothing if the event then fails', async () => {
    const settle = await reactWhileEventInFlight()
    expect(sent).toEqual([])
    settle(false)
    await tick(); await tick()
    expect(sent).toEqual([])
  })

  test('a reaction in flight is sent once the event lands', async () => {
    const settle = await reactWhileEventInFlight()
    expect(sent).toEqual([])
    settle(true)
    await tick(); await tick()
    expect(sent.map(s => s.endpoint)).toEqual([SIGNAL_ENDPOINT])
  })

  test('every chunk of a failed reply refuses a signal, not just the keyed one', async () => {
    const recover = sinkFailingOnce()
    dispose = register()
    emit('reply', { sessionId: 'sess-1', text: 'x', chatId: 'THREAD-1', sentIds: ['c1', 'c2', 'c3'] })
    await tick()
    expect(sent).toEqual([])
    recover()
    for (const id of ['c1', 'c2', 'c3']) {
      emit('reaction', { channelId: 'C', messageId: id, userId: DRIVER, emoji: '-1' })
    }
    await tick()
    expect(sent).toEqual([])
  })

  test('a reaction in the same tick as the reply still resolves', async () => {
    dispose = register()
    emit('reply', { sessionId: 'sess-1', text: 'x', chatId: 'THREAD-1', sentIds: ['fast-1'] })
    emit('reaction', { channelId: 'C', messageId: 'fast-1', userId: DRIVER, emoji: '-1' })
    await tick()
    expect(sent.map(s => s.endpoint)).toEqual([EVENT_ENDPOINT, SIGNAL_ENDPOINT])
  })

  test('an unattributable reply leaves nothing for a later reaction to resolve', async () => {
    // The reply is suppressed, so a later 👎 has no delivered event to attach to.
    stubDeps({ allowedUsers: () => 'unbounded' })
    dispose = register()
    emit('reply', { sessionId: 'sess-1', text: 'x', chatId: 'THREAD-1', sentIds: ['msg-9'] })
    await tick()
    expect(sent).toEqual([])
    process.env.RAINDROP_USER_ID = 'U-owner'
    emit('reaction', { channelId: 'C', messageId: 'msg-9', userId: 'U-owner', emoji: '-1' })
    await tick()
    expect(sent).toEqual([])
    expectNoListenerErrors()
  })
})

describe('raindrop: restart seeding', () => {
  test('a session whose facts do not resolve is not marked as already-reported', async () => {
    // Seeding a session factsFor rejects would suppress its spawn for good.
    let resolvable = false
    stubDeps({
      liveSessionIds: () => ['ghost-1'],
      factsFor: (id) => (id === 'ghost-1' && resolvable ? facts : undefined),
    })
    dispose = register()
    resolvable = true
    emit('session:bridge-registered', { sessionId: 'ghost-1', threadId: 'T' })
    await tick()
    expect(sent.map(s => s.body.event)).toEqual(['hydra.session.spawn'])
  })

  test('sessions live at boot get their facts cached, so death still reports', async () => {
    stubDeps({ liveSessionIds: () => ['sess-1'] })
    dispose = register()
    // A session that survived a restart and whose bridge never came back.
    stubDeps({ liveSessionIds: () => ['sess-1'], factsFor: () => undefined })
    emit('session:death', { sessionId: 'sess-1', threadId: 'THREAD-1', wasOwner: true, tmuxName: 'atlas' })
    await tick()
    expect(sent.map(s => s.body.event)).toEqual(['hydra.session.death'])
    expect(sent[0].body.properties.threadId).toBe('THREAD-1')
    expectNoListenerErrors()
  })

  test('seeding does not itself emit a spawn', async () => {
    stubDeps({ liveSessionIds: () => ['sess-1'] })
    dispose = register()
    await tick()
    expect(sent).toEqual([])
  })
})

describe('raindrop: factsForMain', () => {
  test('parses the model out of the byte pane command', () => {
    expect(factsForMain(NOW)).toEqual({
      threadId: '',
      createdAt: 0,
      tmuxName: 'main',
      engine: 'claude',
      model: 'claude-opus-5[1m]',
      sessionType: 'master_orchestrator',
      platform: PLATFORM,
    })
  })

  test('an unreadable byte pane yields no model rather than a guess', () => {
    stubDeps({ bytePaneCommand: () => '' })
    expect(factsForMain(NOW).model).toBeUndefined()
  })

  test.each([
    [`caffeinate -i claude --model 'claude-opus-5[1m]' --channels x`, 'claude-opus-5[1m]'],
    ['claude --model claude-fable-5 --dangerously-skip-permissions', 'claude-fable-5'],
    ['claude --model="gpt-6-astra"', 'gpt-6-astra'],
    ['claude --resume abc --model claude-opus-4-8[1m]', 'claude-opus-4-8[1m]'],
    ['claude --channels plugin:discord', undefined],
    ['', undefined],
  ])('parseModelFlag(%p) -> %p', (cmd, expected) => {
    expect(parseModelFlag(cmd)).toBe(expected as string)
  })

  test('the pane read is cached, then re-read once the TTL lapses', () => {
    let reads = 0
    stubDeps({ bytePaneCommand: () => { reads++; return `claude --model claude-fable-5` } })
    expect(factsForMain(NOW).model).toBe('claude-fable-5')
    expect(factsForMain(NOW + 1000).model).toBe('claude-fable-5')
    expect(reads).toBe(1)
    // A byte restart can change the model; the TTL is what lets that surface.
    stubDeps({ bytePaneCommand: () => { reads++; return `claude --model claude-opus-5` } })
    expect(factsForMain(NOW + 11 * 60_000).model).toBe('claude-opus-5')
    expect(reads).toBe(2)
  })

  test('the pane reader targets the session, not its current window', () => {
    try {
      process.env.BYTE_SESSION_NAME = 'probe-byte'
      expect(bytePaneArgv()).toEqual(
        ['list-panes', '-s', '-t', 'probe-byte', '-F', '#{pane_start_command}'],
      )
    } finally { delete process.env.BYTE_SESSION_NAME }
    expect(bytePaneArgv()[3]).toBe(`${PLATFORM}-byte`)
  })
})

describe('raindrop: wiring', () => {
  test('every reaction reaches the bus, not just the delete emoji', async () => {
    const seen: string[] = []
    const off = on('reaction', ({ emoji }) => { seen.push(emoji) }, 'test:router-emit')
    await import('../router.js')
    const { gateway } = await import('../config.js')
    // Located via onReaction, so renaming the field it writes fails this test.
    const probe = async () => {}
    const before = Object.fromEntries(Object.keys(gateway).map(k => [k, (gateway as any)[k]]))
    gateway.onReaction!(probe as any)
    const field = Object.keys(gateway).find(k => (gateway as any)[k] === probe)
    expect(field, 'onReaction no longer stores its handler on the gateway').toBeTruthy()
    const handler = before[field!] as
      ((e: { channelId: string; messageId: string; userId: string; emoji: string }) => Promise<void>) | null
    ;(gateway as any)[field!] = handler
    expect(handler, 'the router never registered a reaction handler').toBeTruthy()
    const realDelete = (gateway as any).delete
    ;(gateway as any).delete = async () => {}
    try {
      await handler!({ channelId: 'C', messageId: 'm', userId: 'U1', emoji: '+1' })
      await handler!({ channelId: 'C', messageId: 'm', userId: 'U1', emoji: 'hocho' })
    } finally {
      ;(gateway as any).delete = realDelete
      off()
    }
    expect(seen).toEqual(['+1', 'hocho'])
  })

  test('a failed pane read retries within a minute, not on every reply', () => {
    let reads = 0
    stubDeps({ bytePaneCommand: () => { reads++; return reads === 1 ? '' : BYTE_PANE_CMD } })
    expect(factsForMain(NOW).model).toBeUndefined()
    // A wedged tmux costs up to 2s per exec on the daemon thread; a reply
    // storm must not pay that each time.
    expect(factsForMain(NOW + 30_000).model).toBeUndefined()
    expect(reads).toBe(1)
    expect(factsForMain(NOW + 60_000).model).toBe('claude-opus-5[1m]')
    expect(reads).toBe(2)
  })

  test('a failed read keeps the last good model rather than blanking it', () => {
    let reads = 0
    stubDeps({ bytePaneCommand: () => { reads++; return reads === 1 ? BYTE_PANE_CMD : '' } })
    expect(factsForMain(NOW).model).toBe('claude-opus-5[1m]')
    expect(factsForMain(NOW + 11 * 60_000).model).toBe('claude-opus-5[1m]')
  })

  test('a successful read with no --model flag is cached for the TTL', () => {
    let reads = 0
    stubDeps({ bytePaneCommand: () => { reads++; return 'caffeinate -i claude' } })
    expect(factsForMain(NOW).model).toBeUndefined()
    expect(factsForMain(NOW).model).toBeUndefined()
    expect(reads).toBe(1)
  })

  test('the daemon calls register at boot, unconditionally', () => {
    const src = readFileSync(new URL('../../daemon.ts', import.meta.url), 'utf8')
    const at = src.search(/^registerRaindrop\(\)$/m)
    expect(at, 'daemon.ts never calls registerRaindrop()').toBeGreaterThanOrEqual(0)
    const before = src.slice(0, at)
    expect(before.split('{').length - before.split('}').length,
      'registerRaindrop() sits inside an open block').toBe(0)
  })
})

describe('raindrop: default dry-run sink', () => {
  test('appends owner-only JSONL into the state dir', async () => {
    _resetDeps()
    const path = RAINDROP_DRYRUN_FILE
    try { unlinkSync(path) } catch {}
    _setDeps({ env: () => process.env })
    dispose = register()
    emit('session:bridge-registered', { sessionId: 'nope', threadId: 't' })
    registry.set('dry-1', sessionInfo({
      sessionId: 'dry-1', threadId: 'T-D', tmuxName: 'atlas', createdAt: 5, lastActive: 5,
      sessionMetadata: { role: 'worker', tools: [], model: 'claude-fable-5', cwd: '/x', platform: 'slack' },
    }))
    process.env.RAINDROP_USER_ID = 'U-owner'
    emit('session:bridge-registered', { sessionId: 'dry-1', threadId: 'T-D' })
    emit('session:bridge-registered', { sessionId: 'dry-1', threadId: 'T-D' })
    emit('reply', { sessionId: 'dry-1', text: 'hi', chatId: 'T-D', sentIds: ['m1'] })
    registry.delete('dry-1')

    await tick()
    expect(path.startsWith(STATE_DIR)).toBe(true)
    const lines = readFileSync(path, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines.map(l => JSON.parse(l).body[0].event))
      .toEqual(['hydra.session.spawn', 'hydra.session.reply'])
    expect(statSync(path).mode & 0o777).toBe(0o600)
    unlinkSync(path)
  })
})

describe('raindrop: default allowedUsers and liveSessionIds', () => {
  const accessPath = join(STATE_DIR, 'access.json')

  afterEach(() => { try { unlinkSync(accessPath) } catch {} ; registry.delete('live-1'); registry.delete('dead-1') })

  test('a group entry that is not an object fails closed, not open', () => {
    // drivableBy — not loadAccess — is what throws here; the catch is live.
    writeFileSync(accessPath, JSON.stringify({ allowFrom: ['U1'], groups: { C1: null } }))
    expect(defaultAllowedUsers()).toEqual(new Set())
  })

  test('a corrupt access.json yields no drivers, so nothing is attributable', () => {
    writeFileSync(accessPath, '{ this is not json')
    // access.ts moves the file aside and returns defaults rather than throwing.
    expect(defaultAllowedUsers()).toEqual(new Set())
    expect(resolveUserId(defaultAllowedUsers())).toBe('')
    for (const f of readdirSync(STATE_DIR)) if (f.startsWith('access.json.corrupt-')) unlinkSync(join(STATE_DIR, f))
  })

  test('a readable access.json yields its drivers', () => {
    writeFileSync(accessPath, JSON.stringify({ allowFrom: ['U-a'], groups: {} }))
    expect(defaultAllowedUsers()).toEqual(new Set(['U-a']))
  })

  test('liveSessionIds excludes the already-dead, so boot does not reseed them', () => {
    registry.set('live-1', sessionInfo({ sessionId: 'live-1' }))
    registry.set('dead-1', sessionInfo({ sessionId: 'dead-1', deadAt: 123 }))
    const ids = defaultLiveSessionIds()
    expect(ids).toContain('live-1')
    expect(ids).not.toContain('dead-1')
  })
})

describe('raindrop: post', () => {
  const body = { event_id: 'e', signal_name: 'thumbs_up', signal_type: 'default', sentiment: 'POSITIVE' } as const
  let realFetch: typeof globalThis.fetch

  beforeEach(() => { realFetch = globalThis.fetch })
  afterEach(() => { globalThis.fetch = realFetch })

  test('sends the body as JSON under a bearer write key', async () => {
    process.env.RAINDROP_WRITE_KEY = 'secret-key'
    let seen: { url: string; init: any } | undefined
    globalThis.fetch = (async (url: any, init: any) => {
      seen = { url: String(url), init }
      return new Response('{}', { status: 200 })
    }) as typeof globalThis.fetch
    const realTimeout = AbortSignal.timeout
    const bound = realTimeout.call(AbortSignal, 5_000)
    let timeoutMs: number | undefined
    ;(AbortSignal as unknown as { timeout: (ms: number) => AbortSignal }).timeout = (ms) => {
      timeoutMs = ms
      return bound
    }
    try { await post(SIGNAL_ENDPOINT, [body]) } finally {
      ;(AbortSignal as unknown as { timeout: typeof realTimeout }).timeout = realTimeout
    }
    expect(seen!.url).toBe(SIGNAL_ENDPOINT)
    expect(seen!.init.method).toBe('POST')
    expect(seen!.init.headers.Authorization).toBe('Bearer secret-key')
    expect(seen!.init.headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(seen!.init.body)).toEqual([body])
    // Capturing the argument proves the call happened, not that its result
    // reached fetch — a misspelt `signal:` key leaves every POST unbounded.
    expect(seen!.init.signal, 'the timeout signal must reach fetch').toBe(bound)
    expect(timeoutMs).toBe(5_000)
  })

  test('throws on a non-2xx without leaking the write key', async () => {
    process.env.RAINDROP_WRITE_KEY = 'secret-key'
    globalThis.fetch = (async () => new Response('nope', { status: 500, statusText: 'Server Error' })) as unknown as typeof globalThis.fetch
    const err = await post(SIGNAL_ENDPOINT, [body]).then(() => undefined, (e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err!.message).toContain('500')
    expect(err!.message).not.toContain('secret-key')
  })

  test('propagates a transport rejection', async () => {
    globalThis.fetch = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof globalThis.fetch
    await expect(post(SIGNAL_ENDPOINT, [body])).rejects.toThrow('ECONNREFUSED')
  })
})

describe('raindrop: factsFromRegistry', () => {
  const base = sessionInfo({
    sessionId: 'reg-1', topic: 'wire $2.4M to Acme Corp', threadId: 'T-1',
    createdAt: 1700, lastActive: 1800, tmuxName: 'atlas',
    initiator: 'Kevin Liang', worktreeRepo: '/Users/kevin/RubymineProjects/hydra',
    sessionMetadata: { role: 'worker' as const, tools: [], model: 'claude-opus-5[1m]', cwd: '/x', platform: NOT_PLATFORM },
  })

  afterEach(() => { registry.delete('reg-1') })

  test('maps a real registry entry, carrying no freeform text', () => {
    registry.set('reg-1', base)
    const mapped = factsFromRegistry('reg-1')!
    expect(mapped).toEqual({
      threadId: 'T-1', createdAt: 1700, tmuxName: 'atlas', engine: 'claude',
      model: 'claude-opus-5[1m]', sessionType: 'thread_owner', originType: 'spawn',
      platform: PLATFORM, project: 'hydra',
    })
    expect(JSON.stringify(mapped)).not.toContain('Acme')
    expect(JSON.stringify(mapped)).not.toContain('Kevin Liang')
  })

  test('an absent session maps to nothing', () => {
    expect(factsFromRegistry('no-such-session')).toBeUndefined()
  })

  test('a headless worker maps to nothing — it has no conversation', () => {
    registry.set('reg-1', { ...base, headless: true })
    expect(factsFromRegistry('reg-1')).toBeUndefined()
  })

  test('a session persisted without sessionMetadata still reports a platform', () => {
    registry.set('reg-1', { ...base, sessionMetadata: undefined })
    const mapped = factsFromRegistry('reg-1')!
    expect(mapped.platform).toBe(PLATFORM)
    expect(mapped.model).toBeUndefined()
  })
})

describe('raindrop: live mode', () => {
  test('live mode posts and never touches the dry-run file', async () => {
    process.env.RAINDROP_MODE = 'live'
    process.env.RAINDROP_WRITE_KEY = 'k'
    const posted: Array<{ endpoint: string; body: any }> = []
    stubDeps({
      postEvent: async (endpoint, body) => { posted.push({ endpoint, body }) },
      recordDryRun: () => { throw new Error('dry-run writer must not run in live mode') },
    })
    dispose = register()
    emit('session:bridge-registered', { sessionId: 'sess-1', threadId: 'THREAD-1' })
    await tick()
    expect(posted).toHaveLength(1)
    expect(posted[0].endpoint).toBe(EVENT_ENDPOINT)
    expectNoListenerErrors()
  })

  test('a post failure is contained by the bus and other subscribers still run', async () => {
    process.env.RAINDROP_MODE = 'live'
    process.env.RAINDROP_WRITE_KEY = 'k'
    stubDeps({ postEvent: async () => { throw new Error('raindrop 500') } })
    dispose = register()
    let othersRan = 0
    const offOther = on('session:death', () => { othersRan++ }, 'test:after-raindrop')
    emit('session:bridge-registered', { sessionId: 'sess-1', threadId: 'THREAD-1' })
    await tick()
    expect(() => {
      emit('session:death', { sessionId: 'sess-1', threadId: 'THREAD-1', wasOwner: true, tmuxName: 'atlas' })
    }).not.toThrow()
    await tick()
    offOther()
    expect(othersRan).toBe(1)
    expect(stderr.join('')).toContain('raindrop 500')
  })
})

describe('raindrop: dry-run file is capped', () => {
  test('trimRaindropDryrun front-trims an oversized file and keeps it parseable', () => {
    const path = RAINDROP_DRYRUN_FILE
    const line = JSON.stringify({ endpoint: EVENT_ENDPOINT, body: { event: 'x' } }) + '\n'
    writeFileSync(path, line.repeat(Math.ceil((6 * 1024 * 1024) / line.length)), { mode: 0o600 })
    expect(statSync(path).size).toBeGreaterThan(5 * 1024 * 1024)
    trimRaindropDryrun()
    expect(statSync(path).size).toBeLessThan(5 * 1024 * 1024)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    for (const l of readFileSync(path, 'utf8').trim().split('\n')) JSON.parse(l)
    unlinkSync(path)
  })

  test('the vitals interval trims it even when no session is live', () => {
    const path = RAINDROP_DRYRUN_FILE
    const line = JSON.stringify({ endpoint: EVENT_ENDPOINT, body: { event: 'x' } }) + '\n'
    writeFileSync(path, line.repeat(Math.ceil((6 * 1024 * 1024) / line.length)), { mode: 0o600 })

    const realSetInterval = globalThis.setInterval
    let onTick: (() => void) | undefined
    globalThis.setInterval = ((fn: () => void) => { onTick = fn; return { unref() {} } }) as unknown as typeof setInterval
    try { startVitalsSnapshots(() => true) } finally { globalThis.setInterval = realSetInterval }

    // The registry is shared across the run; an empty fleet is the case under test.
    const saved = [...registry.values()]
    for (const s of saved) registry.delete(s.sessionId)
    try { onTick!() } finally { for (const s of saved) registry.set(s.sessionId, s) }

    expect(statSync(path).size).toBeLessThan(5 * 1024 * 1024)
    unlinkSync(path)
  })
})

describe('raindrop: chat health never renders a path', () => {
  async function healthText(): Promise<string> {
    const { gateway } = await import('../config.js')
    const { handleHealthIntercept } = await import('../commands/status.js')
    const seen: string[] = []
    const realSend = (gateway as any).send
    ;(gateway as any).send = async (_c: string, text: string) => { seen.push(text); return { id: 'm1' } }
    try {
      await handleHealthIntercept({ channelId: 'C1', id: 'm0', text: 'health', userId: 'U1' } as any)
    } finally { (gateway as any).send = realSend }
    return seen.join('\n')
  }

  test('the chat surface renders the basename, never the state-dir path', async () => {
    const text = await healthText()
    expect(text).toContain('• Raindrop: dryrun → raindrop-dryrun.jsonl')
    expect(text).not.toContain(STATE_DIR)
  })

  test('an off install renders no Raindrop line at all', async () => {
    process.env.RAINDROP_MODE = 'off'
    expect(await healthText()).not.toContain('Raindrop')
  })
})
