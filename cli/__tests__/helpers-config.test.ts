import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { resolveConfig, sourceStateDirEnv, buildDaemonEnvs } from '../helpers.js'
import type { HydraConfig } from '../helpers.js'

let savedEnv: NodeJS.ProcessEnv
let stateDir: string

function writeEnv(body: string): void {
  writeFileSync(join(stateDir, '.env'), body)
}

function baseCfg(): HydraConfig {
  return {
    platform: 'slack', stateDir, hydraDir: '/hydra',
    daemonTmux: 'slack-daemon', byteTmux: 'slack-byte', transcribeTmux: 'hydra-transcribe',
    daemonLog: '/tmp/d.log', byteLog: '/tmp/b.log', watchdogLog: '/tmp/w.log',
    sockPath: join(stateDir, 'daemon.sock'), byteModel: 'claude-opus-5[1m]',
    byteAuth: 'auto', byteChannel: '', socketTimeout: 15_000,
    configDir: '/cfg', spawnCwd: '/cwd', spawnCwdBlank: false, byteCwd: '/cwd',
  }
}

function cfg(over: Partial<HydraConfig> = {}): HydraConfig {
  return { ...baseCfg(), ...over }
}

beforeEach(() => {
  savedEnv = { ...process.env }
  for (const k of ['CLAUDE_CONFIG_DIR', 'SPAWN_CWD', 'HYDRA_MODEL', 'BYTE_CWD']) delete process.env[k]
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

test('a whitespace-only SPAWN_CWD is flagged too', () => {
  process.env.SPAWN_CWD = '   '
  expect(sourceStateDirEnv(stateDir).spawnCwdBlank).toBe(true)
})

test('an unset SPAWN_CWD is not flagged', () => {
  writeEnv('CHAT_PLATFORM=slack\n')
  expect(sourceStateDirEnv(stateDir).spawnCwdBlank).toBe(false)
})

test('buildDaemonEnvs forwards HYDRA_MODEL so spawns do not fall back to the compiled default', () => {
  process.env.HYDRA_MODEL = 'claude-opus-5[1m]'
  expect(buildDaemonEnvs(cfg())).toContain(`HYDRA_MODEL='claude-opus-5[1m]'`)
})

test('buildDaemonEnvs omits HYDRA_MODEL when unset or blank', () => {
  expect(buildDaemonEnvs(cfg())).not.toContain('HYDRA_MODEL=')
  process.env.HYDRA_MODEL = '   '
  expect(buildDaemonEnvs(cfg())).not.toContain('HYDRA_MODEL=')
})

test('buildDaemonEnvs carries the resolved config dir', () => {
  expect(buildDaemonEnvs(cfg({ configDir: '/tmp/byte-config' }))).toContain(`CLAUDE_CONFIG_DIR='/tmp/byte-config'`)
})

test('a blank SPAWN_CWD self-heals from the state-dir .env', () => {
  process.env.SPAWN_CWD = ''
  writeEnv('SPAWN_CWD=/tmp/projects\n')
  const r = sourceStateDirEnv(stateDir)
  expect(r.spawnCwd).toBe('/tmp/projects')
  expect(r.spawnCwdBlank).toBe(false)
  expect(buildDaemonEnvs(cfg(r))).toContain(`SPAWN_CWD='/tmp/projects'`)
})

test('a blank SPAWN_CWD with nothing in .env stays flagged and is emitted explicitly', () => {
  process.env.SPAWN_CWD = ''
  writeEnv('CHAT_PLATFORM=slack\n')
  const r = sourceStateDirEnv(stateDir)
  expect(r.spawnCwdBlank).toBe(true)
  expect(buildDaemonEnvs(cfg(r))).toContain("SPAWN_CWD=''")
})

test('buildDaemonEnvs still carries HYDRA_LOG added by the log-capping change', () => {
  expect(buildDaemonEnvs(cfg())).toContain(`HYDRA_LOG='/tmp/d.log'`)
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

test('resolveConfig: byteModel comes from the state-dir HYDRA_MODEL', () => {
  try {
    writePlatformEnv("HYDRA_MODEL='claude-opus-5[1m]'\n")
    expect(resolveConfig(TEST_PLATFORM).byteModel).toBe('claude-opus-5[1m]')
  } finally {
    rmSync(testChannelDir, { recursive: true, force: true })
  }
})

test('a whitespace-only SPAWN_CWD never reaches byteCwd as whitespace', () => {
  process.env.SPAWN_CWD = '   '
  const r = sourceStateDirEnv(stateDir)
  expect(r.spawnCwdBlank).toBe(true)
  expect(r.spawnCwd).toBe(homedir())
  expect(buildDaemonEnvs(cfg({ ...r, byteCwd: r.spawnCwd }))).toContain("SPAWN_CWD=''")
})
