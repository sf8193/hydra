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
  _usageCursorCountForTesting,
  _deliveredCountForTesting,
  errText,
  underSpawnRoot,
  spawnRootIsBounded,
  post,
  factsFromRegistry,
  factsForMain,
  parseModelFlag,
  bytePaneArgv,
  raindropStatusLine,
  defaultAllowedUsers,
  defaultUsageFor,
  defaultProjectFor,
  projectFromGitDir,
  defaultLiveSessionIds,
  UNATTRIBUTED_REPO,
  type RaindropDeps,
  type RaindropMode,
} from '../raindrop.js'
import { EVENT_ENDPOINT, SIGNAL_ENDPOINT, type SessionFacts } from '../raindrop-payload.js'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, statSync, unlinkSync, writeFileSync, readdirSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { mkdirSync as mkdirp, realpathSync, rmSync, symlinkSync } from 'fs'
import { join } from 'path'
import { trimRaindropDryrun, startVitalsSnapshots } from '../observability.js'
import { registry, threadRegistry, type SessionInfo } from '../sessions.js'
import { plantTranscript, uniqueClaudeId } from './projects-fixture.js'
import type { TokenTotals } from '../usage.js'
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
    usageFor: () => undefined,
    env: () => process.env,
    now: () => NOW,
    ...over,
  })
}

beforeEach(() => {
  stderr = []
  realStderr = process.stderr.write
  process.stderr.write = ((chunk: string) => { stderr.push(String(chunk)); return true }) as typeof process.stderr.write
  for (const k of [...SCRUBBED_SPAWN_VARS, 'BYTE_SESSION_NAME', 'SPAWN_CWD']) savedEnv[k] = process.env[k]
  // Every fixture cwd below lives under it — attribution is confined to the
  // spawn root, so a test planting cwds outside one would prove nothing.
  process.env.SPAWN_CWD = '/repos'
  process.env.RAINDROP_MODE = 'dryrun'
  delete process.env.RAINDROP_WRITE_KEY
  delete process.env.RAINDROP_USER_ID
  delete process.env.RAINDROP_OMIT_REPO
  sent = []
  dispose = () => {}
  _resetStateForTesting()
  stubDeps()
})

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length) { try { cleanups.pop()!() } catch {} }
  dispose()
  process.stderr.write = realStderr
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  _resetDeps()
  _resetStateForTesting()
})

// Stubs hand back a SessionUsage; cumulative and delta are the same here
// because each stub represents a single tick's worth of spend.
const zero = (): TokenTotals => ({ inputTokens: 0, outputTokens: 0, cacheCreateTokens: 0, cacheReadTokens: 0 })
const usageOf = (t: Partial<TokenTotals>, claudeSessionId = 'c-test', d?: Partial<TokenTotals>, coldStart = false) => ({
  totals: { ...zero(), ...t },
  delta: { ...zero(), ...(d ?? t) },
  coldStart,
  claudeSessionId,
})

const oneLine = (id: string, n: number) => JSON.stringify({ message: { id, usage: { output_tokens: n } } }) + '\n'

// register() arms a usage tick and a sweep on the same 60s delay, so a capture
// that keeps only one of them depends on registration order. Returns a fire-all.
const intervalDelays: number[] = []
function registerWithIntervals(): () => void {
  const real = globalThis.setInterval
  const fns: Array<() => void> = []
  intervalDelays.length = 0
  globalThis.setInterval = ((fn: () => void, ms?: number) => {
    fns.push(fn); intervalDelays.push(ms ?? 0); return { unref() {} }
  }) as unknown as typeof setInterval
  try { dispose = register() } finally { globalThis.setInterval = real }
  return () => { for (const fn of fns) fn() }
}

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
  test('emitSessionDeath forwards deadAt and the transcript id, so the consumer is not guessing', async () => {
    const seen: any[] = []
    const off = on('session:death', (e) => { seen.push(e) }, 'test:deadAt-producer')
    try {
      emitSessionDeath(sessionInfo({
        sessionId: 's-dead', threadId: 'T-dead', tmuxName: 'atlas', deadAt: 1700, claudeSessionId: 'c-dead',
      }))
      emitSessionDeath(sessionInfo({ sessionId: 's-live', threadId: 'T-live', tmuxName: 'atlas' }))
    } finally { off() }
    expect(seen.map(e => e.deadAt)).toEqual([1700, undefined])
    expect(seen[0].sessionId).toBe('s-dead')
    // killSession deletes the registry entry first, so the final usage read has
    // only this to resolve the transcript with.
    expect(seen[0].claudeSessionId, 'the transcript id must ride the event').toBe('c-dead')
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

describe('raindrop: usage events', () => {
  const tickOnce = registerWithIntervals

  test('the usage tick runs on the cadence its centring assumes', () => {
    tickOnce()
    // A literal, not the constant: deriving it would pass for any value.
    expect(intervalDelays.length, 'both the usage tick and the sweep').toBeGreaterThan(1)
    expect(intervalDelays.every(d => d === 60_000), `every interval must be 60s, got ${intervalDelays.join(', ')}`).toBe(true)
  })

  // The delta is suppressed to 0 on a first sighting, so a dashboard summing a
  // window that spans one has to be able to see which ticks those were.
  test('a first sighting is flagged on the wire, and the next tick is not', async () => {
    const claudeId = uniqueClaudeId('cold')
    const planted = plantTranscript(claudeId, oneLine('m1', 100))
    cleanups.push(planted.cleanup)
    registry.set('cold-1', sessionInfo({ sessionId: 'cold-1', threadId: 'T-cold', claudeSessionId: claudeId }))
    cleanups.push(() => registry.delete('cold-1'))
    stubDeps({ liveSessionIds: () => ['cold-1'], usageFor: defaultUsageFor, factsFor: factsFromRegistry })

    const fire = tickOnce()
    fire()
    await tick()
    const first = sent.filter(x => x.body.event === 'hydra.session.usage').at(-1)
    expect(first, 'no usage event on the first tick').toBeTruthy()
    expect(first!.body.properties.coldStart, 'a fresh cursor is a cold start').toBe(1)
    expect(first!.body.properties.deltaOutputTokens, 'and its delta is suppressed').toBe(0)

    appendFileSync(planted.path, oneLine('m2', 40))
    fire()
    await tick()
    const second = sent.filter(x => x.body.event === 'hydra.session.usage').at(-1)
    expect(second!.body.properties.coldStart, 'a warm cursor is not').toBe(0)
    expect(second!.body.properties.deltaOutputTokens, 'and its delta is real').toBe(40)
  })

  // Both sweep predicates were reversible with the suite green. They differ on
  // purpose, so each needs the direction that keeps an entry, not just the one
  // that drops it.
  test('a cursor is reclaimed when its session leaves the registry without dying', async () => {
    const claudeId = uniqueClaudeId('sweepcur')
    cleanups.push(plantTranscript(claudeId, oneLine('s1', 11)).cleanup)
    registry.set('sw-1', sessionInfo({ sessionId: 'sw-1', threadId: 'T-sw', claudeSessionId: claudeId }))
    cleanups.push(() => registry.delete('sw-1'))
    let known = ['sw-1']
    stubDeps({
      liveSessionIds: () => ['sw-1'], knownSessionIds: () => known,
      usageFor: defaultUsageFor, factsFor: factsFromRegistry,
    })

    const fire = tickOnce()
    fire()
    await tick()
    expect(_usageCursorCountForTesting(), 'the tick must leave a cursor to reclaim').toBe(1)

    fire()
    await tick()
    expect(_usageCursorCountForTesting(), 'still a member, so still retained').toBe(1)

    known = []
    registry.delete('sw-1')
    fire()
    await tick()
    expect(_usageCursorCountForTesting(), 'gone from the registry with no death event').toBe(0)
  })

  test('a still-live session with no transcript stays counted across a sweep', async () => {
    registry.set('u-1', sessionInfo({ sessionId: 'u-1', threadId: 'T-u', claudeSessionId: uniqueClaudeId('never-planted') }))
    cleanups.push(() => registry.delete('u-1'))
    stubDeps({
      liveSessionIds: () => ['u-1'], knownSessionIds: () => ['u-1'],
      usageFor: defaultUsageFor, factsFor: factsFromRegistry,
    })
    expect(defaultUsageFor('u-1'), 'the fixture must not resolve').toBeUndefined()

    const fire = tickOnce()
    fire()
    await tick()
    // The sweep is registered right after the tick and fires on the same turn,
    // so a liveness check that got this wrong would zero the count every time.
    expect(raindropStatusLine('cli'), 'the only alarm for a wrong config dir').toContain('1 session with no transcript yet')
  })

  test('reports the four counters for a live session', async () => {
    stubDeps({
      liveSessionIds: () => ['sess-1'],
      usageFor: () => usageOf(
        { inputTokens: 1, outputTokens: 2, cacheCreateTokens: 3, cacheReadTokens: 4 }, 'c-abc',
        { inputTokens: 10, outputTokens: 20, cacheCreateTokens: 30, cacheReadTokens: 40 },
      ),
      now: () => NOW,
    })
    const tick = tickOnce()
    tick()
    await new Promise(r => setTimeout(r, 0))
    const ev = sent.find(s => s.body.event === 'hydra.session.usage')
    expect(ev, 'no usage event').toBeTruthy()
    expect(ev!.body.properties.tmuxName).toBe('atlas')
    // Named for what they are: a running lifetime total, not a per-tick delta.
    expect(ev!.body.properties.cumulativeCacheReadTokens).toBe(4)
    expect(ev!.body.properties.cumulativeInputTokens).toBe(1)
    expect(ev!.body.properties.cacheReadTokens, 'the ambiguous name must be gone').toBeUndefined()
    // A cumulative gauge cannot answer "spend during a window"; the delta can.
    for (const [key, want] of [
      ['cumulativeInputTokens', 1], ['cumulativeOutputTokens', 2],
      ['cumulativeCacheCreateTokens', 3], ['cumulativeCacheReadTokens', 4],
      ['deltaInputTokens', 10], ['deltaOutputTokens', 20],
      ['deltaCacheCreateTokens', 30], ['deltaCacheReadTokens', 40],
    ] as const) {
      expect(ev!.body.properties[key], `${key} missing from the wire`).toBe(want)
    }
    // The tokens were burned across the interval, not at its end. Stamping the
    // tick moment put up to a full tick of lag into every hourly bucket.
    expect(ev!.body.timestamp, 'the emission is centred in the interval it covers')
      .toBe(new Date(NOW - 30_000).toISOString())
    // Resume gives one transcript several hydra session ids, so without this
    // key no grouping of these events can produce a correct fleet total.
    expect(ev!.body.properties.claudeSessionId, 'the unit of spend must be on the wire').toBe('c-abc')
  })

  test('one session throwing does not stop the rest of the fleet reporting', async () => {
    stubDeps({
      liveSessionIds: () => ['bad', 'sess-1'],
      usageFor: (id) => { if (id === 'bad') throw new Error('transcript exploded'); return usageOf({ outputTokens: 4 }) },
      factsFor: () => facts,
    })
    const tick = tickOnce()
    expect(() => tick()).not.toThrow()
    await new Promise(r => setTimeout(r, 0))
    const usage = sent.filter(s => s.body.event === 'hydra.session.usage')
    expect(usage.length, 'the healthy session must still report').toBe(1)
  })

  test('a session whose totals did not move sends nothing', async () => {
    stubDeps({ liveSessionIds: () => ['sess-1'], usageFor: () => undefined })
    const tick = tickOnce()
    tick()
    await new Promise(r => setTimeout(r, 0))
    expect(sent.find(s => s.body.event === 'hydra.session.usage')).toBeUndefined()
  })

  test('the label rides along so cost can be grouped by what it was for', async () => {
    stubDeps({
      liveSessionIds: () => ['sess-1'],
      factsFor: () => ({ ...facts, label: 'review' }),
      usageFor: () => usageOf({ outputTokens: 9 }),
    })
    const tick = tickOnce()
    tick()
    await new Promise(r => setTimeout(r, 0))
    const ev = sent.find(s => s.body.event === 'hydra.session.usage')!
    expect(ev.body.properties.label).toBe('review')
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

describe('errText', () => {
  // A Bun fetch abort is an Error whose stack is the empty string. `??` only
  // falls back on null/undefined, so a POST timeout logged "send failed (1): "
  // with no reason — observed live, 987 events in, exactly the silent failure
  // the rest of this file exists to prevent.
  test('an error with an empty stack still reports its message', () => {
    const e = Object.assign(new Error('The operation timed out.'), { stack: '' })
    expect(errText(e)).toBe('The operation timed out.')
  })

  test('a stack is preferred when there is one', () => {
    const e = new Error('boom')
    const stack = e.stack ?? ''
    expect(stack, 'this runtime must give real errors a stack').not.toBe('')
    expect(errText(e)).toBe(stack)
  })

  test('an error with neither stack nor message falls back to its name', () => {
    const e = Object.assign(new Error(''), { stack: '' })
    expect(errText(e)).toBe('Error')
  })

  test('a non-Error is stringified', () => {
    expect(errText('plain string')).toBe('plain string')
    expect(errText(undefined)).toBe('undefined')
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
    expect(sent[0].body.properties.repo, 'unresolvable must bucket, not vanish').toBe('none')
    // Within the retry bound the daemon must not fork git again. The clock has
    // to actually advance — at zero elapsed this holds for any bound. 61s is the
    // load-bearing literal: the bound has to outlast a usage tick, or a cwd that
    // will never be a repo re-forks git once a minute for the daemon's life.
    stubDeps({ factsFor: factsFromRegistry, projectFor: () => { calls++; return undefined }, now: () => NOW + 61_000 })
    emit('reply', { sessionId: 'wt-3', text: 'x', chatId: 'T-W3', sentIds: ['m1'] })
    await tick()
    expect(calls, 'a tick later, still no second fork').toBe(1)
    expect(sent[1].body.properties.repo).toBe('none')
    stubDeps({
      factsFor: factsFromRegistry,
      projectFor: () => { calls++; return 'beta' },
      // Literals, not the constant: deriving the clock from the value under
      // test makes the assertion pass for any value of it.
      now: () => NOW + 301_000,
    })
    emit('reply', { sessionId: 'wt-3', text: 'x', chatId: 'T-W3', sentIds: ['m2'] })
    await tick()
    registry.delete('wt-3')
    expect(sent[2].body.properties.repo).toBe('beta')
  })

  // Computing it scans the projects root, tail-reads a transcript and forks git.
  // The operator already said not to send it.
  test('with the repo opted out, attribution is not computed at all', () => {
    const claudeId = uniqueClaudeId('noattrib')
    cleanups.push(plantTranscript(claudeId, JSON.stringify({ cwd: '/repos/gamma' }) + '\n').cleanup)
    registry.set('omit-1', sessionInfo({ sessionId: 'omit-1', threadId: 'T-omit', claudeSessionId: claudeId }))
    cleanups.push(() => registry.delete('omit-1'))
    let lookups = 0
    stubDeps({ factsFor: factsFromRegistry, projectFor: (p: string) => { lookups++; return p.split('/').pop() } })

    expect(factsFromRegistry('omit-1')?.project, 'the default still attributes').toBe('gamma')
    expect(lookups).toBe(1)

    process.env.RAINDROP_OMIT_REPO = '1'
    _resetStateForTesting()
    lookups = 0
    expect(factsFromRegistry('omit-1')?.project).toBeUndefined()
    expect(lookups, 'and no git fork happened for a field nobody reads').toBe(0)
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
    const onSweep = registerWithIntervals()
    emit('session:bridge-registered', { sessionId: 'sess-1', threadId: 'THREAD-1' })
    await tick()
    expect(_trackedSizeForTesting()).toBe(1)
    // A crash detector sets deadAt and emits nothing; the registry is the truth.
    live = []
    onSweep()
    expect(_trackedSizeForTesting()).toBe(0)
  })

  function plant(sessionId: string, body: string): string {
    const claudeId = uniqueClaudeId(sessionId)
    const planted = plantTranscript(claudeId, body)
    cleanups.push(planted.cleanup)
    registry.set(sessionId, sessionInfo({ sessionId, threadId: `T-${sessionId}`, claudeSessionId: claudeId }))
    cleanups.push(() => registry.delete(sessionId))
    return planted.path
  }

  // Every live session read all-zero on its very first tick, so each one filed
  // a usage event saying nothing had been spent.
  test('the first tick is silent when nothing has been spent yet', () => {
    plant('zero-1', JSON.stringify({ type: 'user' }) + '\n')
    expect(defaultUsageFor('zero-1')).toBeUndefined()
  })

  test('the first tick still reports spend that is already on disk', () => {
    plant('spend-1', JSON.stringify({ message: { usage: { output_tokens: 4 } } }) + '\n')
    expect(defaultUsageFor('spend-1')?.totals.outputTokens).toBe(4)
  })

  // Without the cursor carried forward, every tick re-reads from offset 0 and
  // re-reports the session's whole lifetime as if it were new.
  test('an unchanged second tick is silent, and fresh spend reports the larger total', () => {
    const path = plant('delta-1', JSON.stringify({ message: { usage: { output_tokens: 4 } } }) + '\n')
    expect(defaultUsageFor('delta-1')?.totals.outputTokens).toBe(4)
    expect(defaultUsageFor('delta-1'), 'nothing new must send nothing').toBeUndefined()
    appendFileSync(path, JSON.stringify({ message: { usage: { output_tokens: 3 } } }) + '\n')
    expect(defaultUsageFor('delta-1')?.totals.outputTokens, 'cumulative, not a delta').toBe(7)
  })

  // The silent failure mode: point the daemon at the wrong projects root and
  // every session reports nothing while the status line still reads healthy.
  test('a session whose transcript cannot be found is reported, not just skipped', () => {
    registry.set('lost-1', sessionInfo({ sessionId: 'lost-1', threadId: 'T-lost', claudeSessionId: uniqueClaudeId('never-planted') }))
    cleanups.push(() => registry.delete('lost-1'))
    expect(defaultUsageFor('lost-1')).toBeUndefined()
    expect(raindropStatusLine('cli')).toContain('1 session with no transcript yet')
  })

  // The other silent branch: a live claude session whose transcript id has not
  // been discovered yet is exactly what the operator signal is for.
  test('a claude session with no transcript id yet is reported as unresolved', () => {
    registry.set('noid-1', sessionInfo({ sessionId: 'noid-1', threadId: 'T-noid' }))
    cleanups.push(() => registry.delete('noid-1'))
    expect(defaultUsageFor('noid-1')).toBeUndefined()
    expect(raindropStatusLine('cli')).toContain('1 session with no transcript yet')
  })

  // A codex session never has a Claude transcript, so counting it would send
  // the operator after a config path for a session type that has none.
  test('a codex session with no transcript is not reported as unresolved', () => {
    registry.set('cdx-1', sessionInfo({ sessionId: 'cdx-1', threadId: 'T-cdx', engine: 'codex' }))
    cleanups.push(() => registry.delete('cdx-1'))
    expect(defaultUsageFor('cdx-1')).toBeUndefined()
    expect(raindropStatusLine('cli')).not.toContain('no transcript yet')
  })

  test('a codex session holding a transcript id is still not reported as unresolved', () => {
    registry.set('cdx-2', sessionInfo({ sessionId: 'cdx-2', threadId: 'T-cdx2', engine: 'codex', claudeSessionId: uniqueClaudeId('never') }))
    cleanups.push(() => registry.delete('cdx-2'))
    expect(defaultUsageFor('cdx-2')).toBeUndefined()
    expect(raindropStatusLine('cli')).not.toContain('no transcript yet')
  })

  test('a session already gone from the registry is not reported as unresolved', () => {
    expect(defaultUsageFor('never-registered')).toBeUndefined()
    expect(raindropStatusLine('cli')).not.toContain('no transcript yet')
  })

  // A crash sets deadAt and never deletes the registry record, so a
  // membership sweep would pin this entry for the daemon's life and the status
  // line would send the operator after a config path that is fine.
  test('a crashed session stops being counted as unresolved', () => {
    const info = sessionInfo({ sessionId: 'crashu-1', threadId: 'T-cu', claudeSessionId: uniqueClaudeId('crashu') })
    registry.set('crashu-1', info)
    cleanups.push(() => registry.delete('crashu-1'))
    stubDeps({ liveSessionIds: () => (info.deadAt ? [] : ['crashu-1']), usageFor: defaultUsageFor, factsFor: factsFromRegistry })
    expect(defaultUsageFor('crashu-1')).toBeUndefined()
    expect(raindropStatusLine('cli')).toContain('1 session with no transcript yet')

    const fireIntervals = registerWithIntervals()
    // crash detected: deadAt set, registry entry RETAINED, no death emitted
    info.deadAt = NOW
    fireIntervals()
    expect(raindropStatusLine('cli'), 'a crashed session must not nag forever').not.toContain('no transcript yet')
  })

  test('a session that later resolves stops being counted as unresolved', () => {
    const claudeId = uniqueClaudeId('late')
    registry.set('late-1', sessionInfo({ sessionId: 'late-1', threadId: 'T-late', claudeSessionId: claudeId }))
    cleanups.push(() => registry.delete('late-1'))
    expect(defaultUsageFor('late-1')).toBeUndefined()
    expect(raindropStatusLine('cli')).toContain('1 session with no transcript yet')

    cleanups.push(plantTranscript(claudeId, JSON.stringify({ message: { usage: { output_tokens: 2 } } }) + '\n').cleanup)
    expect(defaultUsageFor('late-1')?.totals.outputTokens).toBe(2)
    expect(raindropStatusLine('cli'), 'the count must clear, not latch').not.toContain('no transcript yet')
  })

  test('a dead session stops inflating the unresolved count', () => {
    registry.set('gone-1', sessionInfo({ sessionId: 'gone-1', threadId: 'T-gone', claudeSessionId: uniqueClaudeId('gone') }))
    cleanups.push(() => registry.delete('gone-1'))
    let live = ['gone-1']
    stubDeps({ liveSessionIds: () => live, usageFor: defaultUsageFor, factsFor: factsFromRegistry })
    expect(defaultUsageFor('gone-1')).toBeUndefined()
    expect(raindropStatusLine('cli')).toContain('1 session with no transcript yet')

    const fireIntervals = registerWithIntervals()
    // The sweep retains anything the registry still holds, so a crash-detected
    // session keeps its facts until death fires; gone from the registry is gone.
    live = []
    registry.delete('gone-1')
    fireIntervals()
    expect(raindropStatusLine('cli'), 'a dead session must not be counted forever').not.toContain('no transcript yet')
  })

  // The tick only reads live sessions, so whatever was spent in the final
  // minute died with the session.
  // delta* is the field a window SUMs, so what it may claim is narrow: only a
  // cursor that already pointed at THIS transcript knows what is new. Resume
  // hands a fresh session an old transcript, and a restart loses the cursors —
  // both once claimed the whole history as one tick, inflating a window ~40%.

  test('the first sighting of a transcript is a baseline, not spend', () => {
    const claudeId = uniqueClaudeId('base')
    cleanups.push(plantTranscript(claudeId, oneLine('a', 900)).cleanup)
    registry.set('base-1', sessionInfo({ sessionId: 'base-1', threadId: 'T-base', claudeSessionId: claudeId }))
    cleanups.push(() => registry.delete('base-1'))
    const u = defaultUsageFor('base-1')
    expect(u?.totals.outputTokens, 'the lifetime is still reported').toBe(900)
    expect(u?.delta.outputTokens, 'but none of it is new in this window').toBe(0)
  })

  const usageLine = (id: string, u: Record<string, number>) =>
    JSON.stringify({ message: { id, usage: u } }) + '\n'
  const BASELINE = { input_tokens: 100, output_tokens: 900, cache_creation_input_tokens: 200, cache_read_input_tokens: 300 }
  const GROWTH = { input_tokens: 3, output_tokens: 25, cache_creation_input_tokens: 7, cache_read_input_tokens: 11 }

  const growSession = (id: string) => {
    const claudeId = uniqueClaudeId(id)
    const planted = plantTranscript(claudeId, usageLine('a', BASELINE))
    cleanups.push(planted.cleanup)
    registry.set(id, sessionInfo({ sessionId: id, threadId: `T-${id}`, claudeSessionId: claudeId }))
    cleanups.push(() => registry.delete(id))
    return planted
  }
  const lastUsage = () => sent.filter(x => x.body.event === 'hydra.session.usage').at(-1)

  // Every counter nonzero in the BASELINE too: with zeros there, "to - from"
  // and a bare "to" are indistinguishable, and dropping the subtraction is
  // the ~40% window inflation this whole rule exists to prevent.
  test('growth after a delivered baseline is the delta, on every counter', async () => {
    const planted = growSession('grow-1')
    stubDeps({ liveSessionIds: () => ['grow-1'], usageFor: defaultUsageFor, factsFor: factsFromRegistry })

    const fire = registerWithIntervals()
    fire(); await tick()
    expect(lastUsage()!.body.properties.deltaOutputTokens, 'the first sighting is a baseline').toBe(0)
    expect(lastUsage()!.body.properties.coldStart).toBe(1)

    appendFileSync(planted.path, usageLine('b', GROWTH))
    fire(); await tick()
    const ev = lastUsage()!.body.properties
    expect(ev.cumulativeInputTokens).toBe(103)
    expect(ev.cumulativeOutputTokens).toBe(925)
    expect(ev.cumulativeCacheCreateTokens).toBe(207)
    expect(ev.cumulativeCacheReadTokens).toBe(311)
    expect(
      [ev.deltaInputTokens, ev.deltaOutputTokens, ev.deltaCacheCreateTokens, ev.deltaCacheReadTokens],
      'every counter must be the growth, not just output',
    ).toEqual([3, 25, 7, 11])
    expect(ev.coldStart, 'and it is no longer a first sighting').toBe(0)
  })

  // Every other rotation test calls defaultUsageFor directly, so `delivered` is
  // empty and coldStart is true for the wrong reason — the whole family passed
  // with restartedFromZero ignored. Driving it through the tick is what makes
  // the delivered baseline exist, which is what made it go negative.
  test('a rotation after a delivered baseline never yields a negative delta', async () => {
    const idA = uniqueClaudeId('rotA')
    const idB = uniqueClaudeId('rotB')
    const a = plantTranscript(idA, usageLine('a', { ...BASELINE, output_tokens: 500 }))
    const b = plantTranscript(idB, usageLine('b', { ...BASELINE, output_tokens: 7 }))
    cleanups.push(a.cleanup, b.cleanup)
    const info = sessionInfo({ sessionId: 'rot-1', threadId: 'T-rot', claudeSessionId: idA })
    registry.set('rot-1', info)
    cleanups.push(() => registry.delete('rot-1'))
    let failNext = false
    stubDeps({
      liveSessionIds: () => ['rot-1'], knownSessionIds: () => ['rot-1'],
      usageFor: defaultUsageFor, factsFor: factsFromRegistry,
      recordDryRun: (endpoint, body) => {
        if (failNext && (body as any)[0]?.event === 'hydra.session.usage') throw new Error('502')
        record(endpoint, body)
      },
    })

    const fire = registerWithIntervals()
    fire(); await tick()
    expect(_deliveredCountForTesting(), 'a baseline was delivered').toBe(1)

    // bridge-server reassigns claudeSessionId on a LIVE entry.
    info.claudeSessionId = idB
    failNext = true
    fire(); await tick()

    // The tick after the rotation is where the stale baseline used to be used.
    failNext = false
    fire(); await tick()

    const deltas = sent.filter(x => x.body.event === 'hydra.session.usage')
      .map(x => x.body.properties.deltaOutputTokens as number)
    expect(Math.min(...deltas), `no delta may be negative, got ${deltas.join(', ')}`).toBeGreaterThanOrEqual(0)
  })

  // A kill can land mid-POST. The death read must not compute from a baseline
  // the in-flight event is about to advance, or the same window ships twice
  // under two event ids and the SUM double-counts it. Needs live mode: dryrun
  // resolves instantly and cannot hold a send open across the death.
  test('a death during an in-flight send does not report the window twice', async () => {
    const planted = growSession('race-1')
    let holdUsage: (() => void) | undefined
    let usagePosts = 0
    process.env.RAINDROP_MODE = 'live'
    process.env.RAINDROP_WRITE_KEY = 'rk_live_test'
    stubDeps({
      liveSessionIds: () => ['race-1'], knownSessionIds: () => ['race-1'],
      usageFor: defaultUsageFor, factsFor: factsFromRegistry,
      postEvent: async (endpoint, body) => {
        record(endpoint, body)
        // Hold the SECOND one: the first has to land, or there is no delivered
        // baseline for the death read to double-count from.
        if ((body as any)[0]?.event === 'hydra.session.usage' && ++usagePosts === 2) {
          await new Promise<void>(r => { holdUsage = r })
        }
      },
    })

    const fire = registerWithIntervals()
    fire(); await tick()            // baseline lands, delivered = 900
    appendFileSync(planted.path, usageLine('b', GROWTH))
    fire(); await tick()            // carries the 25, and this POST is held open

    const deathDone = (async () => {
      emit('session:death', {
        sessionId: 'race-1', threadId: 'T-race-1', wasOwner: true, tmuxName: 'atlas', deadAt: NOW,
      })
      await tick()
    })()
    holdUsage?.()
    await deathDone
    for (let n = 0; n < 5; n++) await tick()

    const deltas = sent.filter(x => x.body.event === 'hydra.session.usage')
      .map(x => x.body.properties.deltaOutputTokens as number)
    expect(deltas.reduce((n, d) => n + d, 0),
      `${GROWTH.output_tokens} tokens spent, deltas were [${deltas.join(', ')}]`)
      .toBe(GROWTH.output_tokens)
  })

  test('the delivered baseline is released when its session goes', async () => {
    const planted = growSession('rel-1')
    let known = ['rel-1']
    stubDeps({
      liveSessionIds: () => ['rel-1'], knownSessionIds: () => known,
      usageFor: defaultUsageFor, factsFor: factsFromRegistry,
    })
    const fire = registerWithIntervals()
    fire(); await tick()
    expect(_deliveredCountForTesting(), 'the delivered POST left a baseline').toBe(1)

    fire(); await tick()
    expect(_deliveredCountForTesting(), 'still a registry member, still retained').toBe(1)

    // A death releases it.
    emit('session:death', { sessionId: 'rel-1', threadId: 'T-rel-1', wasOwner: true, tmuxName: 'atlas', deadAt: NOW })
    await tick()
    expect(_deliveredCountForTesting(), 'released on death').toBe(0)

    // And so does leaving the registry without one.
    appendFileSync(planted.path, usageLine('c', GROWTH))
    fire(); await tick()
    expect(_deliveredCountForTesting()).toBe(1)
    known = []
    registry.delete('rel-1')
    fire(); await tick()
    expect(_deliveredCountForTesting(), 'and swept when it leaves the registry').toBe(0)
  })

  // One request per tick, not one per session. The endpoint has always taken
  // an array; the tick is the only producer of N events at one instant.
  test('a tick sends every session in one request', async () => {
    const planted = ['b1', 'b2', 'b3'].map(id => ({ id, p: growSession(id) }))
    stubDeps({
      liveSessionIds: () => planted.map(x => x.id), knownSessionIds: () => planted.map(x => x.id),
      usageFor: defaultUsageFor, factsFor: factsFromRegistry,
    })
    const fire = registerWithIntervals()
    fire(); await tick()

    const usageDispatches = sent.filter(x => x.body.event === 'hydra.session.usage')
    expect(usageDispatches.length, 'one dispatch, not three').toBe(1)
    expect(usageDispatches[0].raw.length, 'carrying all three events').toBe(3)
    expect(new Set(usageDispatches[0].raw.map((b: any) => b.properties.tmuxName)).size).toBe(1)
    expect(usageDispatches[0].raw.map((b: any) => b.event_id).sort())
      .toEqual(planted.map(x => `${x.id}:usage:${NOW}`).sort())

    // "recorded" has to keep counting events, or batching silently divides the
    // operator's only throughput number by the batch size.
    expect(raindropStatusLine('cli'), 'three events, not one request').toContain('3 recorded')
  })

  test('a tick with nothing to report sends no request at all', async () => {
    const claudeId = uniqueClaudeId('quiet')
    cleanups.push(plantTranscript(claudeId, '').cleanup)
    registry.set('quiet-1', sessionInfo({ sessionId: 'quiet-1', threadId: 'T-q', claudeSessionId: claudeId }))
    cleanups.push(() => registry.delete('quiet-1'))
    stubDeps({
      liveSessionIds: () => ['quiet-1'], knownSessionIds: () => ['quiet-1'],
      usageFor: defaultUsageFor, factsFor: factsFromRegistry,
    })
    const fire = registerWithIntervals()
    fire(); await tick()
    expect(sent.filter(x => x.body?.event === 'hydra.session.usage')).toEqual([])
  })

  // All-or-nothing is what makes the retry sound: one failure must not advance
  // any baseline, or the sessions that rode along in it lose their window.
  test('a failed batch re-sends every window in it, none of them lost', async () => {
    const planted = ['r1', 'r2'].map(id => ({ id, p: growSession(id) }))
    let failNext = false
    stubDeps({
      liveSessionIds: () => planted.map(x => x.id), knownSessionIds: () => planted.map(x => x.id),
      usageFor: defaultUsageFor, factsFor: factsFromRegistry,
      recordDryRun: (endpoint, body) => {
        if (failNext && (body as any)[0]?.event === 'hydra.session.usage') throw new Error('502')
        record(endpoint, body)
      },
    })
    const fire = registerWithIntervals()
    fire(); await tick()   // baselines delivered for both

    failNext = true
    for (const { p } of planted) appendFileSync(p.path, usageLine('b', GROWTH))
    fire(); await tick()   // the batch carrying both deltas fails

    failNext = false
    fire(); await tick()   // must come back, for BOTH

    const last = sent.filter(x => x.body.event === 'hydra.session.usage').at(-1)!
    const deltas = last.raw.map((b: any) => b.properties.deltaOutputTokens)
    expect(deltas.length, 'both sessions retried, not just one').toBe(2)
    expect(deltas, 'each carrying the window the failed batch was holding')
      .toEqual([GROWTH.output_tokens, GROWTH.output_tokens])
  })

  // The read cursor moves whether or not the POST lands. Measuring the delta
  // from the read position meant a dropped send deleted that window for good —
  // 80% of a window in the reviewed repro — while cumulative silently healed.
  test('a window whose send failed is re-sent, not lost', async () => {
    const planted = growSession('retry-1')
    let failNext = false
    stubDeps({
      liveSessionIds: () => ['retry-1'], usageFor: defaultUsageFor, factsFor: factsFromRegistry,
      recordDryRun: (endpoint, body) => {
        if (failNext && (body as any)[0]?.event === 'hydra.session.usage') throw new Error('502 from raindrop')
        record(endpoint, body)
      },
    })

    const fire = registerWithIntervals()
    fire(); await tick()
    expect(lastUsage()!.body.properties.coldStart, 'baseline delivered').toBe(1)

    // Spend arrives, and the POST carrying it fails.
    failNext = true
    appendFileSync(planted.path, usageLine('b', GROWTH))
    fire(); await tick()
    expect(lastUsage()!.body.properties.deltaOutputTokens, 'nothing new reached the wire').toBe(0)

    // Next tick: no further spend, but the dropped window must come back.
    failNext = false
    fire(); await tick()
    expect(lastUsage()!.body.properties.deltaOutputTokens, 'the dropped window is re-sent').toBe(25)

    // And once delivered it is not counted a second time.
    fire(); await tick()
    const after = sent.filter(x => x.body.event === 'hydra.session.usage')
    const totalDelta = after.reduce((n, e) => n + (e.body.properties.deltaOutputTokens as number), 0)
    expect(totalDelta, 'the window is counted exactly once across the whole run').toBe(25)
  })

  // readUsageDelta has three exits and each must report the restart. A rotate
  // to a transcript that exists but holds no complete line yet — an ordinary
  // just-created file — takes the other two, and an unreported restart there
  // subtracts the old high-water mark and puts a negative on the wire.
  test.each([
    ['an empty file', ''],
    ['a half-written first line', '{"message":{"id":"x","usage":{"output'],
  ])('rotating to %s never yields a negative delta', (_label, body) => {
    const idA = uniqueClaudeId('negA')
    const idB = uniqueClaudeId('negB')
    cleanups.push(plantTranscript(idA, oneLine('a', 500)).cleanup)
    cleanups.push(plantTranscript(idB, body).cleanup)
    const info = sessionInfo({ sessionId: 'neg-1', threadId: 'T-neg', claudeSessionId: idA })
    registry.set('neg-1', info)
    cleanups.push(() => registry.delete('neg-1'))
    expect(defaultUsageFor('neg-1')?.totals.outputTokens).toBe(500)
    info.claudeSessionId = idB
    const after = defaultUsageFor('neg-1')
    // Suppressed is fine; a reported negative is not.
    if (after) expect(after.delta.outputTokens, 'the restart must reach the base').toBeGreaterThanOrEqual(0)
    expect(after?.totals.outputTokens ?? 0, 'and the totals must follow the new file').toBe(0)
  })

  // Same path, fewer bytes: the reader restarts from zero, and a base chosen by
  // path identity alone could not see that. It emitted delta -55.
  test('a transcript that shrinks in place never yields a negative delta', () => {
    const claudeId = uniqueClaudeId('trunc')
    const planted = plantTranscript(claudeId, oneLine('a', 60).repeat(3))
    cleanups.push(planted.cleanup)
    registry.set('tr-1', sessionInfo({ sessionId: 'tr-1', threadId: 'T-tr', claudeSessionId: claudeId }))
    cleanups.push(() => registry.delete('tr-1'))
    expect(defaultUsageFor('tr-1')?.totals.outputTokens).toBe(60)
    writeFileSync(planted.path, oneLine('b', 5))
    const after = defaultUsageFor('tr-1')
    expect(after?.totals.outputTokens, 'the re-read is the new truth').toBe(5)
    expect(after?.delta.outputTokens, 'a restart is a baseline, not negative spend').toBe(0)
  })

  // A daemon that dies mid-session never runs closeHistoryEntry, so an OPEN
  // entry is all a later respawn has to read the bucket off.
  test('the label lands on the history entry at spawn, before any close', () => {
    const threadId = 'T-openlabel'
    threadRegistry.recordSpawn(threadId, {
      topic: 'open-label', respawnCount: 0, sessionId: 'ol-1', tmuxName: 'x', originType: 'spawn', label: 'build',
    })
    cleanups.push(() => threadRegistry.delete(threadId))
    const entry = threadRegistry.get(threadId)?.sessionHistory.find(h => h.sessionId === 'ol-1')
    expect(entry?.endedAt, 'still open — nothing has closed it').toBeUndefined()
    expect(entry?.label).toBe('build')
  })

  // bridge-server reassigns claudeSessionId on a LIVE entry, so the same cursor
  // can be handed a different file. The old arithmetic went 1.4 BILLION negative.
  test('a transcript swapped under a live session never yields a negative delta', () => {
    const idA = uniqueClaudeId('rotA')
    const idB = uniqueClaudeId('rotB')
    cleanups.push(plantTranscript(idA, oneLine('a', 500)).cleanup)
    cleanups.push(plantTranscript(idB, oneLine('b', 7)).cleanup)
    const info = sessionInfo({ sessionId: 'rot-1', threadId: 'T-rot', claudeSessionId: idA })
    registry.set('rot-1', info)
    cleanups.push(() => registry.delete('rot-1'))
    defaultUsageFor('rot-1')
    info.claudeSessionId = idB
    const after = defaultUsageFor('rot-1')
    expect(after?.totals.outputTokens, 'cumulative follows the new transcript').toBe(7)
    expect(after?.delta.outputTokens, 'the new transcript is a baseline too').toBe(0)
  })

  // Resume mints a fresh hydra sessionId over the SAME transcript. 41 of 140
  // real transcripts are bound to 2-5 session ids, so this is the norm.
  test('a resumed session does not re-claim its predecessor spend', () => {
    const claudeId = uniqueClaudeId('resume')
    cleanups.push(plantTranscript(claudeId, oneLine('a', 400_000)).cleanup)
    registry.set('res-1', sessionInfo({ sessionId: 'res-1', threadId: 'T-res', claudeSessionId: claudeId }))
    cleanups.push(() => registry.delete('res-1'))
    expect(defaultUsageFor('res-1')?.delta.outputTokens).toBe(0)
    // the successor: new hydra sessionId, same transcript, no cursor of its own
    registry.set('res-2', sessionInfo({ sessionId: 'res-2', threadId: 'T-res', claudeSessionId: claudeId }))
    cleanups.push(() => registry.delete('res-2'))
    const u = defaultUsageFor('res-2')
    expect(u?.totals.outputTokens, 'the transcript lifetime is still reported').toBe(400_000)
    expect(u?.delta.outputTokens, 'none of it was spent by the successor').toBe(0)
  })

  // The sweep keys on registry membership, not liveness. A crashed record keeps
  // deadAt set and stays in the registry; sweeping its facts costs both the
  // final usage event and the death event. Uses the real deps on purpose —
  // flipping a stubbed liveSessionIds cannot tell the two predicates apart.
  test('a crashed session keeps its facts through a sweep, with the real deps', async () => {
    const claudeId = uniqueClaudeId('realcrash')
    cleanups.push(plantTranscript(claudeId, oneLine('a', 21)).cleanup)
    const info = sessionInfo({ sessionId: 'rc-1', threadId: 'T-rc', claudeSessionId: claudeId })
    registry.set('rc-1', info)
    cleanups.push(() => registry.delete('rc-1'))
    stubDeps({ factsFor: factsFromRegistry, usageFor: defaultUsageFor })

    const fireIntervals = registerWithIntervals()
    emit('session:bridge-registered', { sessionId: 'rc-1', threadId: 'T-rc' })
    await tick()
    expect(_trackedSizeForTesting()).toBe(1)

    info.deadAt = NOW
    fireIntervals()
    await tick()
    expect(_trackedSizeForTesting(), 'facts must survive the sweep of a crashed session').toBe(1)
  })

  // The crash path: session-health sets deadAt and never emits, so the session
  // leaves liveSessionIds immediately and a sweep runs in the gap. The facts
  // and the cursor both have to survive it or the final read is discarded.
  test('a crashed session still reports its final spend after a sweep', async () => {
    const claudeId = uniqueClaudeId('crash')
    cleanups.push(plantTranscript(claudeId, JSON.stringify({ message: { id: 'c', usage: { output_tokens: 55 } } }) + '\n').cleanup)
    registry.set('crash-1', sessionInfo({ sessionId: 'crash-1', threadId: 'T-crash', claudeSessionId: claudeId }))
    cleanups.push(() => registry.delete('crash-1'))
    let live = ['crash-1']
    stubDeps({ liveSessionIds: () => live, usageFor: defaultUsageFor, factsFor: factsFromRegistry })

    const fireIntervals = registerWithIntervals()
    emit('session:bridge-registered', { sessionId: 'crash-1', threadId: 'T-crash' })
    await tick()

    // crash detected: deadAt set, no death emitted, sweep runs
    live = []
    fireIntervals()
    await tick()

    registry.delete('crash-1')
    emit('session:death', { sessionId: 'crash-1', threadId: 'T-crash', wasOwner: true, tmuxName: 'x', deadAt: 9, claudeSessionId: claudeId })
    await tick()
    const events = sent.map(x => x.body.event)
    expect(events, 'the final usage read must survive the sweep').toContain('hydra.session.usage')
    expect(events).toContain('hydra.session.death')
    const ids = sent.map(x => x.body.event_id)
    expect(new Set(ids).size, `two events sharing an id overwrite: ${ids.join(', ')}`).toBe(ids.length)
    // The final read happened at the instant of death, not the tick moment.
    const finalUsage = sent.find(x => x.body.event === 'hydra.session.usage' && String(x.body.event_id).endsWith(':final'))
    expect(finalUsage?.body.timestamp, 'stamped at deadAt').toBe(new Date(9).toISOString())
  })

  test('a session that never registered a bridge still releases its cursor', async () => {
    const claudeId = uniqueClaudeId('nobridge')
    cleanups.push(plantTranscript(claudeId, oneLine('a', 5)).cleanup)
    registry.set('nb-1', sessionInfo({ sessionId: 'nb-1', threadId: 'T-nb', claudeSessionId: claudeId }))
    cleanups.push(() => registry.delete('nb-1'))
    // The cursor exists, but the session must NOT be live when register()
    // runs — otherwise it seeds `tracked` and the early return never fires.
    stubDeps({ liveSessionIds: () => [], usageFor: defaultUsageFor, factsFor: factsFromRegistry })
    expect(defaultUsageFor('nb-1')?.totals.outputTokens).toBe(5)
    expect(_usageCursorCountForTesting()).toBe(1)
    dispose = register()
    // never bridge-registered, so the handler has no facts and returns early
    emit('session:death', { sessionId: 'nb-1', threadId: 'T-nb', wasOwner: true, tmuxName: 'x', deadAt: 3, claudeSessionId: claudeId })
    await tick()
    expect(_usageCursorCountForTesting(), 'the early return must not skip the release').toBe(0)
  })

  test('a final read that throws still releases the cursor', async () => {
    const claudeId = uniqueClaudeId('boomfinal')
    cleanups.push(plantTranscript(claudeId, oneLine('a', 5)).cleanup)
    registry.set('bf-1', sessionInfo({ sessionId: 'bf-1', threadId: 'T-bf', claudeSessionId: claudeId }))
    cleanups.push(() => registry.delete('bf-1'))
    let boom = false
    stubDeps({
      liveSessionIds: () => ['bf-1'],
      factsFor: factsFromRegistry,
      usageFor: (id: string, hint?: string) => {
        if (boom) throw new Error('transcript vanished at death')
        return defaultUsageFor(id, hint)
      },
    })
    dispose = register()
    emit('session:bridge-registered', { sessionId: 'bf-1', threadId: 'T-bf' })
    await tick()
    expect(defaultUsageFor('bf-1')?.totals.outputTokens).toBe(5)
    expect(_usageCursorCountForTesting()).toBe(1)
    boom = true
    emit('session:death', { sessionId: 'bf-1', threadId: 'T-bf', wasOwner: true, tmuxName: 'x', deadAt: 3, claudeSessionId: claudeId })
    await tick()
    expect(_usageCursorCountForTesting(), 'a throwing read must not leak the cursor').toBe(0)
  })

  // killSession deletes the registry entry BEFORE emitting, so the handler has
  // only what the event carries — a session that dies inside its first tick has
  // no cursor either.
  test('a dying session reports the spend the tick would have missed', async () => {
    const claudeId = uniqueClaudeId('last')
    cleanups.push(plantTranscript(claudeId, JSON.stringify({ message: { usage: { output_tokens: 11 } } }) + '\n').cleanup)
    registry.set('last-1', sessionInfo({ sessionId: 'last-1', threadId: 'T-last', claudeSessionId: claudeId }))
    cleanups.push(() => registry.delete('last-1'))
    stubDeps({ liveSessionIds: () => ['last-1'], usageFor: defaultUsageFor, factsFor: factsFromRegistry })
    dispose = register()
    emit('session:bridge-registered', { sessionId: 'last-1', threadId: 'T-last' })
    await tick()
    registry.delete('last-1')
    emit('session:death', { sessionId: 'last-1', threadId: 'T-last', wasOwner: true, tmuxName: 'atlas', deadAt: 5, claudeSessionId: claudeId })
    await tick()
    const usage = sent.filter(x => x.body.event === 'hydra.session.usage')
    expect(usage.length, 'the final read must be emitted').toBeGreaterThan(0)
    expect(usage[usage.length - 1].body.properties.cumulativeOutputTokens).toBe(11)
  })

  test('a usage reader that throws is counted, not silently skipped', async () => {
    registry.set('boom-1', sessionInfo({ sessionId: 'boom-1', threadId: 'T-boom', claudeSessionId: 'c-boom' }))
    cleanups.push(() => registry.delete('boom-1'))
    stubDeps({
      liveSessionIds: () => ['boom-1'],
      usageFor: () => { throw new Error('transcript vanished mid-read') },
      factsFor: factsFromRegistry,
    })
    const fireIntervals = registerWithIntervals()
    fireIntervals()
    await tick()
    expect(stderr.join(''), 'the cause must reach the log').toContain('transcript vanished mid-read')
    expect(raindropStatusLine('cli'), 'counted as a read failure, not a delivery one').toContain('1 transcript read failure')
    expect(raindropStatusLine('cli'), 'a local read problem must not read as a send failure').not.toContain('1 write error')
  })

  // Graceful degradation: a worktree whose git lookup fails falls through to the
  // transcript cwd rather than bucketing as none. Making the branch terminal
  // changed the answer and nothing noticed.
  test('a worktree whose repo lookup fails falls back to the transcript cwd', () => {
    const claudeId = uniqueClaudeId('wtfail')
    cleanups.push(plantTranscript(claudeId, JSON.stringify({ cwd: '/repos/delta' }) + '\n').cleanup)
    registry.set('wtf-1', sessionInfo({
      sessionId: 'wtf-1', threadId: 'T-wtf', claudeSessionId: claudeId, worktreePath: '/wt/gone', worktreeRepo: '/repos/gone',
    }))
    cleanups.push(() => registry.delete('wtf-1'))
    stubDeps({ factsFor: factsFromRegistry, projectFor: (p: string) => (p === '/repos/gone' ? undefined : p.split('/').pop()) })
    expect(factsFromRegistry('wtf-1')?.project, 'must not stop at the failed worktree').toBe('delta')
  })

  // The seeding loop runs inside register(); a throw there left the daemon
  // half-booted, and the recurring tick had the same call unguarded.
  test('one session with broken facts does not stop the rest being seeded', async () => {
    registry.set('ok-1', sessionInfo({ sessionId: 'ok-1', threadId: 'T-ok' }))
    cleanups.push(() => registry.delete('ok-1'))
    stubDeps({
      liveSessionIds: () => ['bad-1', 'ok-1'],
      factsFor: (id: string) => { if (id === 'bad-1') throw new Error('facts exploded'); return factsFromRegistry(id) },
    })
    expect(() => { dispose = register() }, 'register must not throw').not.toThrow()
    expect(_trackedSizeForTesting(), 'the healthy session must still be seeded').toBe(1)
  })

  test('one session with broken facts does not starve the rest of the tick', async () => {
    const claudeId = uniqueClaudeId('tickok')
    cleanups.push(plantTranscript(claudeId, oneLine('a', 12)).cleanup)
    registry.set('tok-1', sessionInfo({ sessionId: 'tok-1', threadId: 'T-tok', claudeSessionId: claudeId }))
    cleanups.push(() => registry.delete('tok-1'))
    stubDeps({
      liveSessionIds: () => ['bad-1', 'tok-1'],
      usageFor: defaultUsageFor,
      factsFor: (id: string) => { if (id === 'bad-1') throw new Error('facts exploded'); return factsFromRegistry(id) },
    })
    const fireIntervals = registerWithIntervals()
    expect(() => fireIntervals(), 'the tick must not throw out of setInterval').not.toThrow()
    await tick()
    expect(sent.some(x => x.body.event === 'hydra.session.usage'), 'the healthy session still reports').toBe(true)
  })

  // The capability the PR advertises: a session that started outside a repo is
  // attributed from the cwd its transcript records, not from worktreeRepo.
  // Deleting this whole branch previously left the entire suite green.
  test('a session with no worktree is attributed from the transcript cwd', () => {
    const claudeId = uniqueClaudeId('attrib')
    cleanups.push(plantTranscript(claudeId, JSON.stringify({ cwd: '/repos/gamma' }) + '\n').cleanup)
    registry.set('attr-1', sessionInfo({ sessionId: 'attr-1', threadId: 'T-A', claudeSessionId: claudeId }))
    cleanups.push(() => registry.delete('attr-1'))
    stubDeps({ factsFor: factsFromRegistry, projectFor: (p: string) => (p === '/repos/gamma' ? 'gamma' : undefined) })
    expect(factsFromRegistry('attr-1')?.project).toBe('gamma')
  })

  // A wrong CLAUDE_CONFIG_DIR is one fleet-wide condition. It has to reach the
  // operator once with a cause, and it must NOT suppress the unresolved count —
  // making this throw per session did exactly that, and that count is the only
  // place the phrase "check CLAUDE_CONFIG_DIR" appears.
  test('an unreadable projects root is named once and still feeds the unresolved alarm', async () => {
    const saved = process.env.CLAUDE_CONFIG_DIR
    for (const id of ['unread-1', 'unread-2']) {
      registry.set(id, sessionInfo({ sessionId: id, threadId: `T-${id}`, claudeSessionId: `c-${id}` }))
      cleanups.push(() => registry.delete(id))
    }
    stubDeps({
      liveSessionIds: () => ['unread-1', 'unread-2'], knownSessionIds: () => ['unread-1', 'unread-2'],
      usageFor: defaultUsageFor, factsFor: factsFromRegistry, projectFor: () => 'should-not-be-reached',
    })
    process.env.CLAUDE_CONFIG_DIR = join(tmpdir(), `absent-projects-root-${randomUUID()}`)
    try {
      expect(factsFromRegistry('unread-1')?.project, 'attribution degrades').toBe(UNATTRIBUTED_REPO)
      expect(factsFromRegistry('unread-1')?.tmuxName, 'and the event still builds').toBeTruthy()
      expect(() => defaultUsageFor('unread-1'), 'accounting does not throw per session').not.toThrow()

      const fire = registerWithIntervals()
      fire()
      await tick()
      const named = stderr.filter(l => l.includes('projects root unreadable'))
      expect(named.length, 'one line for one fleet-wide condition, not one per session').toBe(1)
      expect(stderr.filter(l => l.includes('transcript read failed')), 'not a per-file failure').toEqual([])

      // A tick count must not masquerade as N unreadable transcripts.
      fire()
      await tick()
      expect(stderr.filter(l => l.includes('projects root unreadable')).length, 'said once, not once a minute').toBe(1)

      const line = raindropStatusLine('cli')
      expect(line, 'the status line names the variable to check').toContain('check CLAUDE_CONFIG_DIR')
      expect(line, 'and the unresolved alarm still fires').toContain('with no transcript yet')
      expect(line, 'without inflating the per-file counter').not.toContain('transcript read failure')
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = saved
    }
  })

  // The cwd is wherever the session wandered to, so it is the one field here
  // that can name a checkout nobody chose to publish.
  test('a cwd outside the spawn root is not named on the wire', () => {
    const claudeId = uniqueClaudeId('outside')
    cleanups.push(plantTranscript(claudeId, JSON.stringify({ cwd: '/elsewhere/private-client' }) + '\n').cleanup)
    registry.set('out-1', sessionInfo({ sessionId: 'out-1', threadId: 'T-O', claudeSessionId: claudeId }))
    cleanups.push(() => registry.delete('out-1'))
    stubDeps({ factsFor: factsFromRegistry, projectFor: (p: string) => p.split('/').pop() })
    expect(factsFromRegistry('out-1')?.project).toBe(UNATTRIBUTED_REPO)

    // Same transcript, same resolver — only the root moves. Without that, the
    // assertion above passes for any reason at all.
    process.env.SPAWN_CWD = '/elsewhere'
    expect(factsFromRegistry('out-1')?.project).toBe('private-client')
  })

  test('with no spawn root configured nothing is attributed from a cwd', () => {
    const claudeId = uniqueClaudeId('norootenv')
    cleanups.push(plantTranscript(claudeId, JSON.stringify({ cwd: '/repos/gamma' }) + '\n').cleanup)
    registry.set('nr-1', sessionInfo({ sessionId: 'nr-1', threadId: 'T-NR', claudeSessionId: claudeId }))
    cleanups.push(() => registry.delete('nr-1'))
    stubDeps({ factsFor: factsFromRegistry, projectFor: () => 'gamma' })
    delete process.env.SPAWN_CWD
    expect(factsFromRegistry('nr-1')?.project).toBe(UNATTRIBUTED_REPO)
  })

  // The spawn root itself is the cwd of every worktree-less spawn, so the
  // equality arm is the common case, not an edge one.
  test('a session sitting at the spawn root is still attributed', () => {
    const claudeId = uniqueClaudeId('atroot')
    cleanups.push(plantTranscript(claudeId, JSON.stringify({ cwd: '/repos' }) + '\n').cleanup)
    registry.set('root-1', sessionInfo({ sessionId: 'root-1', threadId: 'T-R', claudeSessionId: claudeId }))
    cleanups.push(() => registry.delete('root-1'))
    stubDeps({ factsFor: factsFromRegistry, projectFor: (p: string) => p.split('/').pop() })
    expect(factsFromRegistry('root-1')?.project).toBe('repos')
  })

  // /tmp is a symlink to /private/tmp on macOS, and a transcript records the
  // physical path — comparing the spelled root fails closed and says nothing.
  // Builds its own symlink rather than relying on the platform's: macOS tmpdir
  // traverses one (/var → /private/var) and Linux does not, so asserting the
  // difference as a precondition made this fail on the CI runner.
  test('a root spelled through a symlink still contains its own subdirectories', () => {
    const box = mkdtempSync(join(tmpdir(), 'spawnroot-'))
    try {
      const real = join(realpathSync(box), 'root')
      const spelled = join(box, 'alias')
      mkdirSync(real, { recursive: true })
      symlinkSync(real, spelled)
      expect(realpathSync(spelled), 'the alias must resolve elsewhere').toBe(real)

      expect(underSpawnRoot(join(real, 'repo'), spelled), 'physical cwd, symlinked root').toBe(true)
      expect(underSpawnRoot(join(realpathSync(box), 'elsewhere'), spelled), 'outside is still outside').toBe(false)
      // The mirror: a cwd spelled through the alias against the physical root.
      // Only the root side was ever exercised, so half the rule was unpinned.
      mkdirp(join(real, "repo"), { recursive: true })
      expect(underSpawnRoot(join(spelled, 'repo'), real), 'symlinked cwd, physical root').toBe(true)
    } finally { rmSync(box, { recursive: true, force: true }) }
  })

  // Refusing the root turns attribution off for the whole fleet, and two of the
  // three launchers default SPAWN_CWD to $HOME — so it has to say so.
  test.each([undefined, () => homedir(), () => '/'])(
    'an unbounded spawn root (%p) is named on the status line', (root) => {
      const saved = process.env.SPAWN_CWD
      try {
        const value = typeof root === 'function' ? root() : root
        if (value === undefined) delete process.env.SPAWN_CWD
        else process.env.SPAWN_CWD = value
        expect(raindropStatusLine('cli')).toContain('repo attribution is off')
      } finally { process.env.SPAWN_CWD = saved }
    })

  test('a real spawn root says nothing about attribution', () => {
    expect(raindropStatusLine('cli')).not.toContain('repo attribution is off')
  })

  test.each([
    ['the home directory', () => homedir()],
    ['the filesystem root', () => '/'],
  ])('%s is refused as a spawn root, so nothing is attributed', (_case, root) => {
    expect(spawnRootIsBounded(root()), 'not a bound').toBe(false)
    expect(underSpawnRoot(join(root(), 'anything', 'repo'), root())).toBe(false)
    // A real root still works, so the refusal is not blanket.
    expect(spawnRootIsBounded('/repos')).toBe(true)
    expect(underSpawnRoot('/repos/gamma', '/repos')).toBe(true)
  })

  // A sibling of the root is not inside it: a raw startsWith would ship this.
  test('a sibling directory of the spawn root is not inside it', () => {
    const claudeId = uniqueClaudeId('sibling')
    cleanups.push(plantTranscript(claudeId, JSON.stringify({ cwd: '/repos-private/acme' }) + '\n').cleanup)
    registry.set('sib-1', sessionInfo({ sessionId: 'sib-1', threadId: 'T-S', claudeSessionId: claudeId }))
    cleanups.push(() => registry.delete('sib-1'))
    stubDeps({ factsFor: factsFromRegistry, projectFor: (p: string) => p.split('/').pop() })
    expect(factsFromRegistry('sib-1')?.project).toBe(UNATTRIBUTED_REPO)
  })

  test('the latest cwd wins, so a session that moved is attributed where it is now', () => {
    const claudeId = uniqueClaudeId('moved')
    const body = JSON.stringify({ cwd: '/repos/old' }) + '\n' + JSON.stringify({ cwd: '/repos/new' }) + '\n'
    cleanups.push(plantTranscript(claudeId, body).cleanup)
    registry.set('moved-1', sessionInfo({ sessionId: 'moved-1', threadId: 'T-M', claudeSessionId: claudeId }))
    cleanups.push(() => registry.delete('moved-1'))
    stubDeps({ factsFor: factsFromRegistry, projectFor: (p: string) => p.split('/').pop() })
    expect(factsFromRegistry('moved-1')?.project).toBe('new')
  })

  // bridge-server reassigns claudeSessionId on a LIVE registry entry, and the
  // project cache never expires on success — so without an identity check the
  // first answer latches for the session's life.
  test('a project resolved from one transcript is not reused after the id changes', () => {
    const idA = uniqueClaudeId('swapA')
    const idB = uniqueClaudeId('swapB')
    cleanups.push(plantTranscript(idA, JSON.stringify({ cwd: '/repos/alpha' }) + '\n').cleanup)
    cleanups.push(plantTranscript(idB, JSON.stringify({ cwd: '/repos/beta' }) + '\n').cleanup)
    const info = sessionInfo({ sessionId: 'swap-1', threadId: 'T-sw', claudeSessionId: idA })
    registry.set('swap-1', info)
    cleanups.push(() => registry.delete('swap-1'))
    stubDeps({ factsFor: factsFromRegistry, projectFor: (p: string) => p.split('/').pop() })
    expect(factsFromRegistry('swap-1')?.project).toBe('alpha')
    info.claudeSessionId = idB
    expect(factsFromRegistry('swap-1')?.project, 'must not latch the old transcript').toBe('beta')
  })

  test('a session whose transcript names no repo buckets as none', () => {
    const claudeId = uniqueClaudeId('norepo')
    cleanups.push(plantTranscript(claudeId, JSON.stringify({ cwd: '/repos/notarepo' }) + '\n').cleanup)
    registry.set('norepo-1', sessionInfo({ sessionId: 'norepo-1', threadId: 'T-N', claudeSessionId: claudeId }))
    cleanups.push(() => registry.delete('norepo-1'))
    stubDeps({ factsFor: factsFromRegistry, projectFor: () => undefined })
    expect(factsFromRegistry('norepo-1')?.project).toBe(UNATTRIBUTED_REPO)
  })

  test('a dead session leaves no usage cursor behind', async () => {
    const claudeId = uniqueClaudeId('claude-cursor')
    cleanups.push(plantTranscript(claudeId, JSON.stringify({ message: { usage: { output_tokens: 7 } } }) + '\n').cleanup)
    registry.set('cur-1', sessionInfo({
      sessionId: 'cur-1', threadId: 'T-C', tmuxName: 'atlas', createdAt: 5, lastActive: 5,
      claudeSessionId: claudeId,
    }))
    cleanups.push(() => registry.delete('cur-1'))
    let live = ['cur-1']
    stubDeps({ liveSessionIds: () => live, usageFor: defaultUsageFor, factsFor: factsFromRegistry })

    const fireIntervals = registerWithIntervals()

    fireIntervals()
    await tick()
    expect(_usageCursorCountForTesting(), 'the real reader must have left a cursor').toBe(1)

    // A crash sets deadAt long before session:death fires, so the session
    // leaves liveSessionIds first. The cursor has to outlive that gap or the
    // final read has nothing to resolve the transcript with.
    live = []
    fireIntervals()
    await tick()
    expect(_usageCursorCountForTesting(), 'the cursor must survive until death is emitted').toBe(1)

    registry.delete('cur-1')
    emit('session:death', { sessionId: 'cur-1', threadId: 'T-C', wasOwner: true, tmuxName: 'atlas', deadAt: 9, claudeSessionId: claudeId })
    await tick()
    expect(_usageCursorCountForTesting(), 'and must be released once it has').toBe(0)
  })

  // Resolved fresh each time: a cached answer went stale as a session moved,
  // and the git lookup behind it is already cached by repo path.
  test('a session that moves to another repo is re-attributed immediately', () => {
    const claudeId = uniqueClaudeId('movefast')
    const planted = plantTranscript(claudeId, JSON.stringify({ cwd: '/repos/alpha' }) + '\n')
    cleanups.push(planted.cleanup)
    registry.set('mf-1', sessionInfo({ sessionId: 'mf-1', threadId: 'T-mf', claudeSessionId: claudeId }))
    cleanups.push(() => registry.delete('mf-1'))
    stubDeps({ factsFor: factsFromRegistry, projectFor: (p: string) => p.split('/').pop() })
    expect(factsFromRegistry('mf-1')?.project).toBe('alpha')
    appendFileSync(planted.path, JSON.stringify({ cwd: '/repos/beta' }) + '\n')
    expect(factsFromRegistry('mf-1')?.project, 'no stale window at all').toBe('beta')
  })

  // A headless session has no facts ever; reading its transcript would advance
  // the cursor past spend that nothing will report.
  test('a session with no facts is skipped before its transcript is read', () => {
    const claudeId = uniqueClaudeId('headless')
    cleanups.push(plantTranscript(claudeId, JSON.stringify({ message: { usage: { output_tokens: 6 } } }) + '\n').cleanup)
    registry.set('hl-1', sessionInfo({ sessionId: 'hl-1', threadId: 'T-hl', claudeSessionId: claudeId, headless: true }))
    cleanups.push(() => registry.delete('hl-1'))
    let read = 0
    stubDeps({
      liveSessionIds: () => ['hl-1'],
      factsFor: factsFromRegistry,
      usageFor: (id: string) => { read++; return defaultUsageFor(id) },
    })
    const fireIntervals = registerWithIntervals()
    fireIntervals()
    expect(read, 'the transcript must not be read for a session that cannot report').toBe(0)
  })

  test('each usage emission gets its own id, so they do not overwrite each other', async () => {
    let n = 0
    stubDeps({
      liveSessionIds: () => ['sess-1'],
      usageFor: () => usageOf({ outputTokens: ++n }),
      now: () => NOW + n * 1000,
    })
    const fireIntervals = registerWithIntervals()
    fireIntervals()
    await tick()
    fireIntervals()
    await tick()
    const ids = sent.filter(s => s.body.event === 'hydra.session.usage').map(s => s.body.event_id)
    expect(ids.length).toBe(2)
    expect(new Set(ids).size, `ids collided: ${ids.join(', ')}`).toBe(2)
  })

  test('a reply landing after the death does not resurrect the entry for good', async () => {
    let live = ['sess-1']
    stubDeps({ liveSessionIds: () => live })
    const onSweep = registerWithIntervals()
    emit('session:bridge-registered', { sessionId: 'sess-1', threadId: 'THREAD-1' })
    await tick()
    emit('session:death', { sessionId: 'sess-1', threadId: 'THREAD-1', wasOwner: true, tmuxName: 'atlas' })
    await tick()
    emit('reply', { sessionId: 'sess-1', text: 'late', chatId: 'THREAD-1', sentIds: ['m1'] })
    await tick()
    expect(_trackedSizeForTesting(), 'the late reply re-added it').toBe(1)
    live = []
    onSweep()
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
      platform: PLATFORM, project: 'hydra', label: undefined,
    })
    expect(JSON.stringify(mapped)).not.toContain('Acme')
    expect(JSON.stringify(mapped)).not.toContain('Kevin Liang')
  })

  test("a labelled session carries its label out of the registry", () => {
    registry.set('reg-2', sessionInfo({ ...base, sessionId: 'reg-2', label: 'review' }))
    try {
      expect(factsFromRegistry('reg-2')!.label).toBe('review')
    } finally { registry.delete('reg-2') }
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

describe('the durable history entry a resume reads back', () => {
  const mk = (id: string) => {
    threadRegistry.recordSpawn(id, { sessionId: `${id}-s`, tmuxName: 'x', originType: 'spawn' } as never)
    cleanups.push(() => threadRegistry.delete(id))
    return `${id}-s`
  }
  const entryOf = (id: string) => threadRegistry.get(id)?.sessionHistory.find(h => h.sessionId === `${id}-s`)

  // killSession deletes the registry record, so everything a later resume
  // needs has to be on this entry before it closes.
  test('closing stamps every identity field, including the cost bucket', () => {
    const t = 'T-rk'; mk(t)
    threadRegistry.closeHistoryEntry(t, {
      sessionId: `${t}-s`, messageCount: 7,
      claudeSessionId: 'c-rk', engine: 'codex', codexThreadId: 'cx-1', codexHomeName: 'home-1', label: 'build',
    })
    expect(entryOf(t)).toMatchObject({
      messageCount: 7, claudeSessionId: 'c-rk', engine: 'codex',
      codexThreadId: 'cx-1', codexHomeName: 'home-1', label: 'build',
    })
    expect(entryOf(t)?.endedAt).toBeTruthy()
  })

  test('a close that names no label leaves the one recorded at spawn', () => {
    const t = 'T-keeplabel'
    threadRegistry.recordSpawn(t, {
      topic: 'keep', respawnCount: 0, sessionId: `${t}-s`, tmuxName: 'x', originType: 'spawn', label: 'build',
    })
    cleanups.push(() => threadRegistry.delete(t))
    threadRegistry.closeHistoryEntry(t, { sessionId: `${t}-s`, messageCount: 3, claudeSessionId: 'c-keep' })
    expect(entryOf(t)?.endedAt, 'the entry really did close').toBeTruthy()
    expect(entryOf(t)?.label, 'a crash close must not blank the bucket').toBe('build')
  })

  // A crash closes the entry first; a later kill must not reopen it and reset
  // what the crash recorded.
  test('a second close does not overwrite the first', () => {
    const t = 'T-twice'; mk(t)
    threadRegistry.closeHistoryEntry(t, { sessionId: `${t}-s`, messageCount: 5, claudeSessionId: 'c-first', label: 'review' })
    const closedAt = entryOf(t)!.endedAt
    threadRegistry.closeHistoryEntry(t, { sessionId: `${t}-s`, messageCount: 0, claudeSessionId: 'c-second' })
    expect(entryOf(t)?.endedAt, 'the close time must stand').toBe(closedAt)
    expect(entryOf(t)?.claudeSessionId, 'and so must the recorded id').toBe('c-first')
    expect(entryOf(t)?.messageCount).toBe(5)
    expect(entryOf(t)?.label).toBe('review')
  })

  // This diff moved persistence into closeHistoryEntry — the two crash callers
  // dropped their own persist() calls. Without it a crash-closed label lives
  // only in memory and vanishes at the next daemon restart.
  test('the closed entry reaches disk, not just the in-memory map', () => {
    const t = 'T-disk'; mk(t)
    threadRegistry.closeHistoryEntry(t, { sessionId: `${t}-s`, messageCount: 3, claudeSessionId: 'c-disk', label: 'investigate' })
    const onDisk = JSON.parse(readFileSync(join(STATE_DIR, 'threads.json'), 'utf8')) as Array<{ threadId: string; sessionHistory: Array<Record<string, unknown>> }>
    const entry = onDisk.find(x => x.threadId === t)?.sessionHistory.find(h => h.sessionId === `${t}-s`)
    expect(entry, 'the thread must be on disk').toBeTruthy()
    expect(entry?.label, 'and the bucket with it').toBe('investigate')
    expect(entry?.claudeSessionId).toBe('c-disk')
  })

  test('a close with the field absent does not blank what spawn recorded', () => {
    const t = 'T-keep'
    threadRegistry.recordSpawn(t, { sessionId: `${t}-s`, tmuxName: 'x', originType: 'fork', claudeSessionId: 'c-from-spawn' } as never)
    cleanups.push(() => threadRegistry.delete(t))
    // the crash path: bridge never connected, so info carries no transcript id
    threadRegistry.closeHistoryEntry(t, { sessionId: `${t}-s`, messageCount: 0 })
    expect(entryOf(t)?.claudeSessionId, 'a later resume needs this').toBe('c-from-spawn')
  })
})
