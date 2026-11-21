import { test, expect, describe, beforeAll, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { resolveConfig, defaultPlatform, pickSocket, sourceStateDirEnv, buildDaemonEnvs, printResponse, byteModel } from '../helpers.js'
import { SCRUBBED_SPAWN_VARS } from '../../shared/spawn-env.js'
import type { HydraConfig } from '../helpers.js'

let savedEnv: NodeJS.ProcessEnv
const PINNED = { path: '/pinned/bin/bun' }
let stateDir: string

function writeEnv(body: string): void {
  writeFileSync(join(stateDir, '.env'), body)
}

function baseCfg(): HydraConfig {
  return {
    platform: 'slack', stateDir, hydraDir: '/hydra',
    daemonTmux: 'slack-daemon', byteTmux: 'slack-byte', transcribeTmux: 'hydra-transcribe',
    daemonLog: '/tmp/d.log', byteLog: '/tmp/b.log', watchdogLog: '/tmp/w.log',
    sockPath: join(stateDir, 'daemon.sock'),
    byteAuth: 'auto', byteChannel: '', socketTimeout: 15_000,
    configDir: '/cfg', spawnCwd: '/cwd', spawnCwdBlank: false, byteCwd: '/cwd',
  }
}

function cfg(over: Partial<HydraConfig> = {}): HydraConfig {
  return { ...baseCfg(), ...over }
}

beforeEach(() => {
  savedEnv = { ...process.env }
  for (const k of ['CLAUDE_CONFIG_DIR', 'SPAWN_CWD', 'HYDRA_MODEL', 'BYTE_CWD', ...SCRUBBED_SPAWN_VARS]) delete process.env[k]
  stateDir = mkdtempSync(join(tmpdir(), 'hydra-sd-'))
})

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true })
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k]
  for (const [k, v] of Object.entries(savedEnv)) if (process.env[k] !== v) process.env[k] = v as string
})

test('configDir comes from the state-dir .env, not the ambient default', () => {
  writeEnv('CLAUDE_CONFIG_DIR=/tmp/byte-config\n')
  expect(sourceStateDirEnv(stateDir).configDir).toBe('/tmp/byte-config')
})

test('real env beats the state-dir .env', () => {
  process.env.CLAUDE_CONFIG_DIR = '/tmp/from-real-env'
  writeEnv('CLAUDE_CONFIG_DIR=/tmp/from-dotenv\n')
  expect(sourceStateDirEnv(stateDir).configDir).toBe('/tmp/from-real-env')
})

test('a set-but-empty CLAUDE_CONFIG_DIR falls back instead of yielding an empty path', () => {
  process.env.CLAUDE_CONFIG_DIR = ''
  expect(sourceStateDirEnv(stateDir).configDir).toBe(join(homedir(), '.claude'))
})

test('a missing .env leaves the defaults intact', () => {
  const r = sourceStateDirEnv(stateDir)
  expect(r.configDir).toBe(join(homedir(), '.claude'))
  expect(r.spawnCwdBlank).toBe(false)
})

test('inline comments are stripped from .env values', () => {
  writeEnv('CLAUDE_CONFIG_DIR=/tmp/byte-config  # bot config\n')
  expect(sourceStateDirEnv(stateDir).configDir).toBe('/tmp/byte-config')
})

test('indented and CRLF .env lines are still honoured', () => {
  writeEnv("  CLAUDE_CONFIG_DIR=/tmp/byte-config\r\n\tSPAWN_CWD=/tmp/projects\r\n")
  const r = sourceStateDirEnv(stateDir)
  expect(r.configDir).toBe('/tmp/byte-config')
  expect(r.spawnCwd).toBe('/tmp/projects')
})

test('a set-but-empty SPAWN_CWD is flagged rather than silently becoming homedir', () => {
  writeEnv('SPAWN_CWD=\n')
  const r = sourceStateDirEnv(stateDir)
  expect(r.spawnCwdBlank).toBe(true)
  expect(r.spawnCwd).toBe(homedir())
})

test('an unset SPAWN_CWD is not flagged', () => {
  writeEnv('CHAT_PLATFORM=slack\n')
  expect(sourceStateDirEnv(stateDir).spawnCwdBlank).toBe(false)
})

test('buildDaemonEnvs forwards HYDRA_MODEL so spawns do not fall back to the compiled default', () => {
  process.env.HYDRA_MODEL = 'claude-opus-5[1m]'
  expect(buildDaemonEnvs(cfg(), PINNED)).toContain(`HYDRA_MODEL='claude-opus-5[1m]'`)
})

test('buildDaemonEnvs omits HYDRA_MODEL when unset or blank', () => {
  expect(buildDaemonEnvs(cfg(), PINNED)).not.toContain('HYDRA_MODEL=')
  process.env.HYDRA_MODEL = '   '
  expect(buildDaemonEnvs(cfg(), PINNED)).not.toContain('HYDRA_MODEL=')
})

test('buildDaemonEnvs carries the resolved config dir', () => {
  expect(buildDaemonEnvs(cfg({ configDir: '/tmp/byte-config' }), PINNED)).toContain(`CLAUDE_CONFIG_DIR='/tmp/byte-config'`)
})

test('a blank SPAWN_CWD self-heals from the state-dir .env', () => {
  process.env.SPAWN_CWD = ''
  writeEnv('SPAWN_CWD=/tmp/projects\n')
  const r = sourceStateDirEnv(stateDir)
  expect(r.spawnCwd).toBe('/tmp/projects')
  expect(r.spawnCwdBlank).toBe(false)
  expect(buildDaemonEnvs(cfg(r), PINNED)).toContain(`SPAWN_CWD='/tmp/projects'`)
})

test('a blank SPAWN_CWD with nothing in .env stays flagged and is emitted explicitly', () => {
  process.env.SPAWN_CWD = ''
  writeEnv('CHAT_PLATFORM=slack\n')
  const r = sourceStateDirEnv(stateDir)
  expect(r.spawnCwdBlank).toBe(true)
  expect(buildDaemonEnvs(cfg(r), PINNED)).toContain("SPAWN_CWD=''")
})

test('buildDaemonEnvs still carries HYDRA_LOG added by the log-capping change', () => {
  expect(buildDaemonEnvs(cfg(), PINNED)).toContain(`HYDRA_LOG='/tmp/d.log'`)
})

// --- wiring: these drive resolveConfig itself, so they fail if the ordering
// regresses even though sourceStateDirEnv stays correct by construction.
// An explicit platform derives stateDir from ~/.claude/channels/<platform>
// (#344), so the temp state dir has to live there under a test-only name.

const TEST_PLATFORM = `hydratest-${process.pid}`
const channelsRoot = join(homedir(), '.claude', 'channels')

// A killed run (Ctrl-C, SIGKILL, OOM) skips the per-test finally. A leftover
// hydratest-* dir makes the bare `hydra` CLI refuse to auto-detect a platform,
// so sweep any stragglers before this file runs.
beforeAll(() => {
  if (!existsSync(channelsRoot)) return
  for (const d of readdirSync(channelsRoot).filter(d => d.startsWith('hydratest-'))) {
    rmSync(join(channelsRoot, d), { recursive: true, force: true })
  }
})
const testChannelDir = join(homedir(), '.claude', 'channels', TEST_PLATFORM)

function writePlatformEnv(body: string): void {
  mkdirSync(testChannelDir, { recursive: true })
  writeFileSync(join(testChannelDir, '.env'), body)
}

test('resolveConfig takes configDir from the state-dir .env, not the pre-source env', () => {
  try {
    writePlatformEnv('CLAUDE_CONFIG_DIR=/tmp/byte-config\n')
    expect(resolveConfig(TEST_PLATFORM).configDir).toBe('/tmp/byte-config')
  } finally {
    rmSync(testChannelDir, { recursive: true, force: true })
  }
})

test('resolveConfig takes byteCwd from the state-dir SPAWN_CWD', () => {
  try {
    writePlatformEnv('SPAWN_CWD=/tmp/projects\n')
    const cfg = resolveConfig(TEST_PLATFORM)
    expect(cfg.spawnCwd).toBe('/tmp/projects')
    expect(cfg.byteCwd).toBe('/tmp/projects')
  } finally {
    rmSync(testChannelDir, { recursive: true, force: true })
  }
})

test('resolveConfig: a set-but-empty BYTE_CWD falls back rather than producing `cd ""`', () => {
  try {
    writePlatformEnv('SPAWN_CWD=/tmp/projects\nBYTE_CWD=\n')
    expect(resolveConfig(TEST_PLATFORM).byteCwd).toBe('/tmp/projects')
  } finally {
    rmSync(testChannelDir, { recursive: true, force: true })
  }
})

test('without [main] model, the byte model comes from the state-dir HYDRA_MODEL', () => {
  try {
    writePlatformEnv("HYDRA_MODEL='claude-opus-5[1m]'\n")
    expect(byteModel(resolveConfig(TEST_PLATFORM)).model).toBe('claude-opus-5[1m]')
  } finally {
    rmSync(testChannelDir, { recursive: true, force: true })
  }
})

test('resolveConfig: state-dir HYDRA_MODEL wins over a stale ambient value (tmux env freeze)', () => {
  try {
    process.env.HYDRA_MODEL = 'claude-sonnet-5[1m]' // simulates a frozen tmux-server env
    writePlatformEnv("HYDRA_MODEL='claude-sonnet-5-5[1m]'\n")
    expect(byteModel(resolveConfig(TEST_PLATFORM)).model).toBe('claude-sonnet-5-5[1m]')
  } finally {
    rmSync(testChannelDir, { recursive: true, force: true })
  }
})

test('a whitespace-only SPAWN_CWD never reaches byteCwd as whitespace', () => {
  process.env.SPAWN_CWD = '   '
  const r = sourceStateDirEnv(stateDir)
  expect(r.spawnCwdBlank).toBe(true)
  expect(r.spawnCwd).toBe(homedir())
  expect(buildDaemonEnvs(cfg({ ...r, byteCwd: r.spawnCwd }), PINNED)).toContain("SPAWN_CWD=''")
})

function capturedHealth(data: Record<string, unknown>): string {
  const lines: string[] = []
  const real = console.log
  console.log = (...args: unknown[]) => { lines.push(args.join(' ')) }
  try { printResponse({ ok: true, command: 'health', data }, false) } finally { console.log = real }
  return lines.join('\n')
}

const HEALTH = {
  sessions: { total: 1, connected: 1, disconnected: 0 },
  tmux: 'ok',
  idempotency: { active: 0 },
}

test('hydra health names a refused restricted launch, with what to do; none reported, no line (#669)', () => {
  const out = capturedHealth({ ...HEALTH, refusedLaunches: [{ specialist: 'ops', why: 'it loaded an unlisted server', ageMin: 4 }] })
  expect(out).toContain('restricted specialist ops: launch REFUSED 4 min ago (it loaded an unlisted server) · fix: send it another message')
  expect(capturedHealth(HEALTH)).not.toContain('REFUSED')
  // an engine that cannot check what it loaded is refused too: the fix does not blame Claude Code's setup
  const other = capturedHealth({ ...HEALTH, refusedLaunches: [{ specialist: 'ops', why: 'the codex engine cannot check what it loaded', ageMin: 1 }] })
  expect(other).toContain("the engine's launch record (Claude Code: its debug file)")
  expect(other).not.toContain("check Claude Code's setup")
})

test('hydra health says a restricted specialist is refused on a macOS version the sandbox is not proven on, or runs there by opt-in; none reported, no line', () => {
  const refused = capturedHealth({ ...HEALTH, macosGate: { version: '13.4', allowed: false, specialists: ['ops', 'desk'] } })
  expect(refused).toMatch(/REFUSED: restricted specialists ops, desk: .*macOS 13\.4.*allow_unproven_macos = true/)
  const allowed = capturedHealth({ ...HEALTH, macosGate: { version: '13.4', allowed: true, specialists: ['ops'] } })
  expect(allowed).toMatch(/WARNING: restricted specialist ops: .*macOS 13\.4.*lets it run anyway/)
  expect(capturedHealth(HEALTH)).not.toContain('macOS')
})

test('sourceStateDirEnv loads the .env but keeps no RAINDROP_ value in this process', () => {
  writeEnv(`${SCRUBBED_SPAWN_VARS.map(v => `${v}=seeded`).join('\n')}\nSPAWN_CWD=/tmp/x\n`)
  sourceStateDirEnv(stateDir)
  expect(process.env.SPAWN_CWD).toBe('/tmp/x')
  for (const v of SCRUBBED_SPAWN_VARS) expect(process.env[v]).toBeUndefined()
})


test('resolveConfig: byteTmux honours BYTE_SESSION_NAME, and a blank one falls through', () => {
  process.env.BYTE_SESSION_NAME = 'custom-byte'
  expect(resolveConfig(TEST_PLATFORM).byteTmux).toBe('custom-byte')
  process.env.BYTE_SESSION_NAME = ''
  expect(resolveConfig(TEST_PLATFORM).byteTmux).toBe(`${TEST_PLATFORM}-byte`)
})

test('buildDaemonEnvs leads PATH with the pinned bun, so the daemon and every bun it starts run the pin', () => {
  process.env.PATH = '/caller/bun/bin:/usr/bin'
  expect(buildDaemonEnvs(cfg(), PINNED)).toStartWith(`PATH='/pinned/bin:/caller/bun/bin:/usr/bin' `)
})

test('buildDaemonEnvs leaves PATH alone when no bun path resolved', () => {
  process.env.PATH = '/usr/bin'
  expect(buildDaemonEnvs(cfg({ daemonLog: join(stateDir, 'd.log') }), { path: 'bun', fallback: 'x' })).toStartWith(`PATH='/usr/bin' `)
})

describe('a refused deliver, in text mode', () => {
  const refused = (response: Record<string, unknown>): { stderr: string[]; exit: number | undefined } => {
    const stderr: string[] = []
    let exit: number | undefined
    const err = console.error, ex = process.exit
    console.error = (...a: unknown[]) => { stderr.push(a.join(' ')) }
    process.exit = ((c?: number) => { exit = c; throw new Error('exit') }) as never
    try { printResponse(response, false) } catch (e) { if ((e as Error).message !== 'exit') throw e } finally { console.error = err; process.exit = ex }
    return { stderr, exit }
  }

  test('a deferred error line ends with [deferred], and the exit code is the daemon\'s, unchanged', () => {
    expect(refused({ ok: false, command: 'deliver', error: 'x is still booting', exitCode: 5, result: 'deferred' })).toEqual({ stderr: ['error: x is still booting [deferred]'], exit: 5 })
  })

  test('failed and done carry no suffix', () => {
    expect(refused({ ok: false, command: 'deliver', error: 'stuck: unknown_dialog', exitCode: 5, result: 'failed' })).toEqual({ stderr: ['error: stuck: unknown_dialog'], exit: 5 })
    expect(refused({ ok: false, command: 'deliver', error: 'already delivered', exitCode: 2, result: 'done' })).toEqual({ stderr: ['error: already delivered'], exit: 2 })
  })

  test('an error with no result word (any other command) prints as it always did', () => {
    expect(refused({ ok: false, command: 'kill', error: 'no such session' })).toEqual({ stderr: ['error: no such session'], exit: 1 })
  })
})

describe('defaultPlatform: which platform a command without one targets', () => {
  let channels: string
  beforeEach(() => {
    channels = mkdtempSync(join(tmpdir(), 'hydra-channels-'))
    for (const d of ['discord', 'slack']) mkdirSync(join(channels, d))
  })
  afterEach(() => rmSync(channels, { recursive: true, force: true }))

  test('CHAT_PLATFORM names the platform when two platform state dirs exist (#747)', () => {
    expect(defaultPlatform('discord', channels)).toBe('discord')
    expect(defaultPlatform(' slack ', channels)).toBe('slack')
  })

  test('two state dirs and no CHAT_PLATFORM (unset or blank) is refused, saying how to choose', () => {
    for (const v of [undefined, '  ']) expect(() => defaultPlatform(v, channels)).toThrow(/CHAT_PLATFORM not set and 2 platform state dirs exist\nset CHAT_PLATFORM .*--state-dir/)
  })

  test('a CHAT_PLATFORM that is not discord or slack is refused, not turned into a state dir', () => {
    for (const v of ['github', 'foo', '../x']) expect(() => defaultPlatform(v, channels)).toThrow(`CHAT_PLATFORM must be discord or slack, not "${v}"`)
  })

  test('a directory that is not a platform is no state dir', () => {
    rmSync(join(channels, 'slack'), { recursive: true })
    mkdirSync(join(channels, 'github'))
    expect(defaultPlatform(undefined, channels)).toBe('discord')
    mkdirSync(join(channels, 'slack'))
    expect(() => defaultPlatform(undefined, channels)).toThrow('2 platform state dirs')
  })

  test('one state dir is the platform; none is discord', () => {
    rmSync(join(channels, 'slack'), { recursive: true })
    expect(defaultPlatform(undefined, channels)).toBe('discord')
    rmSync(join(channels, 'discord'), { recursive: true })
    mkdirSync(join(channels, 'slack'))
    expect(defaultPlatform(undefined, channels)).toBe('slack')
    expect(defaultPlatform(undefined, join(channels, 'absent'))).toBe('discord')
  })
})

describe('pickSocket: which daemon a command talks to', () => {
  const both = { discord: '/d.sock', slack: '/s.sock' }

  test('CHAT_PLATFORM names the daemon when two are registered (#785)', () => {
    expect(pickSocket(both, undefined, 'discord')).toBe('/d.sock')
    expect(pickSocket(both, undefined, ' slack ')).toBe('/s.sock')
  })

  test('--daemon beats CHAT_PLATFORM; the only daemon is chosen without either', () => {
    expect(pickSocket(both, 'slack', 'discord')).toBe('/s.sock')
    expect(pickSocket({ slack: '/s.sock' }, undefined, undefined)).toBe('/s.sock')
    // Unlike defaultPlatform: with one daemon, that daemon is the only one a command can reach, whatever the variable says.
    expect(pickSocket({ slack: '/s.sock' }, undefined, 'discord')).toBe('/s.sock')
  })

  test('two daemons and no CHAT_PLATFORM (unset or blank) is refused, saying how to choose', () => {
    for (const v of [undefined, ' ']) expect(() => pickSocket(both, undefined, v)).toThrow(/multiple daemons found: discord, slack\nset CHAT_PLATFORM, or use --daemon/)
  })

  test('CHAT_PLATFORM naming no running daemon, or not a platform, is refused', () => {
    expect(() => pickSocket({ ...both, extra: '/e.sock' }, undefined, 'discord')).not.toThrow()
    expect(() => pickSocket({ slack: '/s.sock', other: '/o.sock' }, undefined, 'discord')).toThrow('daemon "discord" not found\ndiscovered: slack, other')
    expect(() => pickSocket(both, undefined, 'github')).toThrow('CHAT_PLATFORM must be discord or slack, not "github"')
  })
})
