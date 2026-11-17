import { connect } from 'net'
import { existsSync, readdirSync, statSync, unlinkSync, readFileSync, writeFileSync } from 'fs'
import { join, dirname, basename } from 'path'
import { homedir } from 'os'
import { execSync, execFileSync } from 'child_process'
import { resolveLaunchModel, spawnModel, TRANSCRIBE_TMUX, byteTmuxName, claudeConfigDir, platformStateDir } from '../shared/constants.js'
import { tmuxNewSession, captureSpawnVars, withRaisedFdLimit } from '../shared/spawn-env.js'
import { scrubTokenVarsInFile } from '../config/token-vars.js'
import { sourceEnvFiles, parseEnvLine } from '../shared/env-parse.js'
import { formatIssues, loadHydraConfig, systemEnv } from '../config/load.js'
import { SESSION_NAMES } from '../shared/session-catalog.js'
import { macosGateIssue } from '../config/server-sandbox.js'

// ---------------------------------------------------------------------------
// Config resolution (replaces env-setup.sh)
// ---------------------------------------------------------------------------

export type HydraConfig = {
  platform: string
  stateDir: string
  configDir: string
  spawnCwd: string
  hydraDir: string
  daemonTmux: string
  byteTmux: string
  transcribeTmux: string
  daemonLog: string
  byteLog: string
  watchdogLog: string
  sockPath: string
  byteAuth: 'auto' | 'keychain'
  byteCwd: string
  spawnCwdBlank: boolean
  byteChannel: string
  socketTimeout: number
}

export function readEnvFileValue(path: string, key: string): string | undefined {
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const parsed = parseEnvLine(line)
      if (parsed && parsed[0] === key) return parsed[1]
    }
  } catch {}
  return undefined
}

export function sourceStateDirEnv(stateDir: string): { configDir: string; spawnCwd: string; spawnCwdBlank: boolean } {
  sourceEnvFiles([join(stateDir, '.env')])
  // sourceEnvFiles only backfills a blank var. A tmux server freezes its env at first
  // launch (see CLAUDE.md), so HYDRA_MODEL can sit stale in every session's ambient env
  // long after the state-dir .env is edited. .env is the intended source of truth for
  // this one, so it wins here even over a non-blank ambient value.
  const fileModel = readEnvFileValue(join(stateDir, '.env'), 'HYDRA_MODEL')
  if (fileModel?.trim()) process.env.HYDRA_MODEL = fileModel.trim()
  // The CLI must not forward these to the daemon it launches.
  scrubTokenVarsInFile(join(stateDir, 'hydra.toml'))
  captureSpawnVars()
  return {
    configDir: claudeConfigDir(),
    spawnCwd: process.env.SPAWN_CWD?.trim() || homedir(),
    spawnCwdBlank: process.env.SPAWN_CWD !== undefined && process.env.SPAWN_CWD.trim() === '',
  }
}

/** CHAT_PLATFORM's value: undefined when unset or blank; throws on anything but discord or slack. */
export function chatPlatformOf(value: string | undefined): 'discord' | 'slack' | undefined {
  const named = value?.trim()
  if (!named) return undefined
  if (named !== 'discord' && named !== 'slack') throw new Error(`CHAT_PLATFORM must be discord or slack, not "${named}"`)
  return named
}

/**
 * The platform for a command that was given none: CHAT_PLATFORM (discord or slack, as the daemon's gateway runs); else the one platform
 * state dir there is; else discord. Throws, with the words to print, on a CHAT_PLATFORM that is neither, and on several state dirs with
 * no CHAT_PLATFORM to choose. Not "explicit" to the caller: HYDRA_STATE_DIR keeps beating the platform's default dir.
 */
export function defaultPlatform(chatPlatform: string | undefined, channelsDir: string): string {
  const named = chatPlatformOf(chatPlatform)
  if (named) return named
  let dirs: string[] = []
  try {
    dirs = readdirSync(channelsDir).filter(d => {
      if (d !== 'discord' && d !== 'slack') return false
      try { return statSync(join(channelsDir, d)).isDirectory() } catch { return false }
    })
  } catch {}
  if (dirs.length === 1) return dirs[0]
  if (dirs.length > 1) throw new Error(`CHAT_PLATFORM not set and ${dirs.length} platform state dirs exist\nset CHAT_PLATFORM (discord or slack), or pass --state-dir <dir>`)
  return 'discord'
}

export function resolveConfig(platform?: string): HydraConfig {
  // Ensure PATH includes common tool locations (mirrors env-setup.sh).
  // Critical for launchd context where PATH is minimal.
  const extraPaths = [
    join(homedir(), '.npm-global', 'bin'),
    join(homedir(), '.asdf', 'shims'),
    join(homedir(), '.local', 'bin'),
    join(homedir(), '.bun', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ]
  const currentPath = process.env.PATH ?? ''
  const missing = extraPaths.filter(p => !currentPath.includes(p))
  if (missing.length > 0) {
    process.env.PATH = [...missing, currentPath].join(':')
  }

  const hydraDir = join(import.meta.dir, '..')

  const platformExplicit = !!platform
  if (!platform) {
    try { platform = defaultPlatform(process.env.CHAT_PLATFORM, join(homedir(), '.claude', 'channels')) } catch (err) {
      console.error(`error: ${(err as Error).message}`)
      process.exit(1)
    }
  }

  // When platform is explicit, derive stateDir from it — env vars may belong to
  // a different platform (e.g. a session spawned by the slack daemon running
  // `hydra up discord` inherits HYDRA_STATE_DIR pointing at slack).
  const stateDir = platformExplicit
    ? platformStateDir(platform)
    : process.env.HYDRA_STATE_DIR ?? process.env.DISCORD_STATE_DIR ?? platformStateDir(platform)

  const { configDir, spawnCwd, spawnCwdBlank } = sourceStateDirEnv(stateDir)

  return {
    platform,
    stateDir,
    configDir,
    spawnCwd,
    spawnCwdBlank,
    hydraDir,
    daemonTmux: `${platform}-daemon`,
    byteTmux: byteTmuxName(platform),
    transcribeTmux: TRANSCRIBE_TMUX,
    daemonLog: process.env.HYDRA_LOG ?? join(homedir(), `hydra-${platform}-daemon.log`),
    byteLog: process.env.HYDRA_BYTE_LOG ?? join(homedir(), `hydra-${platform}-byte.log`),
    watchdogLog: process.env.HYDRA_WATCHDOG_LOG ?? join(homedir(), 'hydra-watchdog.log'),
    sockPath: join(stateDir, 'daemon.sock'),
    byteAuth: (process.env.HYDRA_AUTH?.trim() ?? 'auto') === 'keychain' ? 'keychain' : 'auto',
    byteCwd: process.env.BYTE_CWD || spawnCwd,
    byteChannel: process.env.BYTE_CHANNEL ?? '',
    socketTimeout: Math.max(Number(process.env.HYDRA_SOCKET_TIMEOUT) || 15_000, 1_000),
  }
}

/** The model main (the byte) starts with, where it came from, and why hydra.toml was not read when it was not. */
export type ByteModel = { model: string; from: '[main] model in hydra.toml' | 'HYDRA_MODEL' | 'the default'; problem?: string }

/**
 * The model main starts with: hydra.toml's `[main] model`, resolved as a specialist's `model` is; without one, the spawn default
 * (HYDRA_MODEL, else DEFAULT_MODEL), as before. Read at each start, so an edit applies at main's next start. A hydra.toml that does
 * not load (a typo in an unrelated table, as the daemon keeps its last good config through) still gives its `[main] model`, read
 * on its own; only an unreadable `[main]` falls back to the spawn default, and says why. A byte that will not start is worse.
 */
export function byteModel(cfg: Pick<HydraConfig, 'stateDir' | 'platform' | 'configDir'>): ByteModel {
  const fallback = (problem?: string): ByteModel =>
    ({ model: spawnModel(), from: process.env.HYDRA_MODEL?.trim() ? 'HYDRA_MODEL' : 'the default', ...(problem && { problem }) })
  let text: string
  try { text = readFileSync(join(cfg.stateDir, 'hydra.toml'), 'utf8') } catch { return fallback() }
  const r = loadHydraConfig(text, systemEnv(SESSION_NAMES, cfg.stateDir, statePlatform(cfg.stateDir, undefined, cfg.platform), cfg.configDir))
  if (!r.ok) {
    let doc: Record<string, unknown> | undefined
    try { doc = Bun.TOML.parse(text) as Record<string, unknown> } catch { /* not TOML at all */ }
    const own = (doc?.main as Record<string, unknown> | undefined)?.model
    if (typeof own === 'string' && own.trim()) return { model: resolveLaunchModel(own), from: '[main] model in hydra.toml' }
    const saysMain = doc ? Object.hasOwn(doc, 'main') : /^\s*\[main\]/m.test(text)
    return saysMain ? fallback(`hydra.toml does not load and its [main] model can't be read, so main starts on the spawn default:\n${formatIssues(r.errors)}`) : fallback()
  }
  return r.config.main ? { model: resolveLaunchModel(r.config.main.model), from: '[main] model in hydra.toml' } : fallback()
}

// ---------------------------------------------------------------------------
// Plugin version discovery
// ---------------------------------------------------------------------------

// Locate the installed bridge-plugin version dir, e.g. `.../discord/0.0.5`.
// Avoids hardcoding a version that breaks on the next plugin release. Prefers a
// dir that already holds server.ts; otherwise the newest by numeric sort.
export function pluginVersionDir(configDir: string, plugin = 'discord'): string | null {
  const base = join(configDir, 'plugins', 'cache', 'claude-plugins-official', plugin)
  try {
    const versions = readdirSync(base).filter(v => {
      try { return statSync(join(base, v)).isDirectory() } catch { return false }
    })
    if (versions.length === 0) return null
    versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    const withServer = versions.find(v => existsSync(join(base, v, 'server.ts')))
    return join(base, withServer ?? versions[0])
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stderr.write(`pluginVersionDir: ${err}\n`)
    }
    return null
  }
}

// ---------------------------------------------------------------------------
// tmux helpers
// ---------------------------------------------------------------------------

function execEnv(): Record<string, string | undefined> {
  return process.env as Record<string, string | undefined>
}

export function tmuxExists(name: string): boolean {
  try {
    execFileSync('tmux', ['has-session', '-t', name], { stdio: 'pipe', env: execEnv() })
    return true
  } catch { return false }
}

export function tmuxKill(name: string): void {
  try { execFileSync('tmux', ['kill-session', '-t', name], { stdio: 'pipe', env: execEnv() }) } catch {}
}

export function tmuxSpawn(name: string, command: string): void {
  // Its own, longer bound: the CLI has no event loop to protect, only an operator waiting on `hydra start`.
  tmuxNewSession(['-d', '-s', name, withRaisedFdLimit(command)], { timeout: 30_000, killSignal: 'SIGKILL' })
}

export function tmuxSessionAge(name: string): number | null {
  try {
    const created = execFileSync('tmux', ['display-message', '-t', name, '-p', '#{session_created}'], { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8', env: execEnv() }).trim()
    return Math.floor(Date.now() / 1000) - parseInt(created)
  } catch { return null }
}

// ---------------------------------------------------------------------------
// Compile check (replaces compile-check.sh)
// ---------------------------------------------------------------------------

export async function compileCheck(hydraDir: string): Promise<{ ok: boolean; errors: string }> {
  const errors: string[] = []
  for (const entry of ['daemon.ts', 'bridge.ts']) {
    const result = await Bun.build({
      entrypoints: [join(hydraDir, entry)],
      target: 'bun',
    })
    if (!result.success) {
      const msgs = result.logs.map(l => l.message ?? String(l)).join('\n')
      errors.push(`[${entry}] ${msgs}`)
    }
  }
  return { ok: errors.length === 0, errors: errors.join('\n') }
}

// ---------------------------------------------------------------------------
// Orphan byte killer (replaces kill-orphan-bytes.sh)
// Catches: old byte processes (HYDRA_ROLE=main) and unconfigured bridges with
// DAEMON_SOCK in env. Does NOT catch terminal sessions that resolved the socket
// via fallback (no DAEMON_SOCK env) — those are inert by design (stray id,
// no main tools).
// ---------------------------------------------------------------------------

export function killOrphanBytes(sockPath: string, logPath: string, signal?: string): void {
  try {
    const pids = execFileSync('pgrep', ['-f', 'claude.*--channels'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], env: execEnv() }).trim()
    if (!pids) return
    for (const pidStr of pids.split('\n')) {
      const pid = parseInt(pidStr.trim())
      if (isNaN(pid)) continue
      try {
        const pinfo = execFileSync('ps', ['eww', '-p', String(pid)], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], env: execEnv() })
        if (pinfo.includes(`DAEMON_SOCK=${sockPath}`) && !pinfo.includes('HYDRA_SESSION_ID=')) {
          appendLog(logPath, `killing orphaned byte process ${pid}`)
          if (signal === '-9') {
            process.kill(pid, 'SIGKILL')
          } else {
            process.kill(pid, 'SIGTERM')
          }
        }
      } catch {}
    }
  } catch {}
}

export function hasOrphanBytes(sockPath: string): boolean {
  try {
    const pids = execFileSync('pgrep', ['-f', 'claude.*--channels'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], env: execEnv() }).trim()
    if (!pids) return false
    for (const pidStr of pids.split('\n')) {
      const pid = parseInt(pidStr.trim())
      if (isNaN(pid)) continue
      try {
        const pinfo = execFileSync('ps', ['eww', '-p', String(pid)], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], env: execEnv() })
        if (pinfo.includes(`DAEMON_SOCK=${sockPath}`) && !pinfo.includes('HYDRA_SESSION_ID=')) {
          return true
        }
      } catch {}
    }
  } catch {}
  return false
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

export function appendLog(logPath: string, msg: string): void {
  try {
    const line = `${new Date().toLocaleString()}: ${msg}\n`
    writeFileSync(logPath, line, { flag: 'a' })
  } catch {}
}

// ---------------------------------------------------------------------------
// Shell quoting
// ---------------------------------------------------------------------------

export function shq(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

// ---------------------------------------------------------------------------
// Wait for socket
// ---------------------------------------------------------------------------

export async function waitForSocket(sockPath: string, timeoutMs: number, quiet = false): Promise<boolean> {
  const start = Date.now()
  if (!quiet) process.stdout.write('waiting for socket')
  while (Date.now() - start < timeoutMs) {
    if (existsSync(sockPath)) {
      try {
        if (statSync(sockPath).isSocket()) {
          if (!quiet) process.stdout.write(' ready\n')
          return true
        }
      } catch {}
    }
    if (!quiet) process.stdout.write('.')
    await Bun.sleep(500)
  }
  if (!quiet) process.stdout.write(' timeout\n')
  return false
}

// ---------------------------------------------------------------------------
// Health probe — connect to daemon socket and confirm it answers
// ---------------------------------------------------------------------------

export function probeDaemonHealth(sockPath: string, timeoutMs = 5000): Promise<{ ok: boolean; error?: string }> {
  return new Promise(resolve => {
    const socket = connect(sockPath)
    let buf = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve({ ok: false, error: 'health probe timeout' })
    }, timeoutMs)

    socket.on('connect', () => {
      socket.write(JSON.stringify({ type: 'cli', command: 'health', id: 'probe' }) + '\n')
    })

    function settle(result: { ok: boolean; error?: string }): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(result)
    }

    socket.on('data', (data: Buffer) => {
      buf += data.toString()
      const nl = buf.indexOf('\n')
      if (nl !== -1 && !settled) {
        try {
          const resp = JSON.parse(buf.slice(0, nl))
          settle({ ok: !!resp.ok })
        } catch {
          settle({ ok: false, error: 'invalid response' })
        }
      }
    })

    socket.on('error', (err) => {
      settle({ ok: false, error: err.message })
    })

    socket.on('end', () => {
      settle({ ok: false, error: buf ? 'incomplete response' : 'closed without response' })
    })
  })
}

// ---------------------------------------------------------------------------
// Socket discovery & communication
// ---------------------------------------------------------------------------

export function discoverSockets(): Record<string, string> {
  const channelsDir = join(homedir(), '.claude', 'channels')
  const found: Record<string, string> = {}
  try {
    for (const name of readdirSync(channelsDir)) {
      const sockPath = join(channelsDir, name, 'daemon.sock')
      try {
        if (existsSync(sockPath) && statSync(sockPath).isSocket()) {
          found[name] = sockPath
        }
      } catch {}
    }
  } catch {}
  return found
}

/**
 * The daemon socket a command talks to: the one `--daemon` names; else the only one; else, with several, the one CHAT_PLATFORM names
 * (`defaultPlatform` reads the variable first; here a lone daemon is the only thing a command can reach, so it wins). Throws, with the words
 * to print, when none is chosen. A daemon is found by its state dir's name, so CHAT_PLATFORM names only a discord or slack one.
 */
export function pickSocket(discovered: Record<string, string>, daemonName: string | undefined, chatPlatform: string | undefined): string {
  const keys = Object.keys(discovered)
  const missing = (name: string) => new Error(`daemon "${name}" not found\ndiscovered: ${keys.join(', ') || '(none)'}`)

  if (daemonName) {
    if (discovered[daemonName]) return discovered[daemonName]
    throw missing(daemonName)
  }
  if (keys.length === 1) return discovered[keys[0]]
  if (keys.length === 0) throw new Error('no running daemons found')

  const platform = chatPlatformOf(chatPlatform)
  if (platform) {
    if (discovered[platform]) return discovered[platform]
    throw missing(platform)
  }
  throw new Error(`multiple daemons found: ${keys.join(', ')}\nset CHAT_PLATFORM, or use --daemon <name> to select one`)
}

export function resolveSocket(daemonName?: string): string {
  try { return pickSocket(discoverSockets(), daemonName, process.env.CHAT_PLATFORM) } catch (err) {
    console.error(`error: ${(err as Error).message}`)
    process.exit(1)
  }
}

/** `timeoutMs`: how long to wait for the reply; a request that spawns a session needs more than the default. */
export function sendRequest(socketPath: string, request: Record<string, unknown>, timeoutMs = 10_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    let buf = ''
    const timeout = setTimeout(() => {
      socket.destroy()
      reject(new Error('connection timed out'))
    }, timeoutMs)

    socket.on('connect', () => {
      socket.write(JSON.stringify(request) + '\n')
    })

    socket.on('data', (data: Buffer) => {
      buf += data.toString()
      const nl = buf.indexOf('\n')
      if (nl !== -1) {
        clearTimeout(timeout)
        const line = buf.slice(0, nl)
        socket.end()
        try {
          resolve(JSON.parse(line))
        } catch {
          reject(new Error(`invalid response: ${line.slice(0, 200)}`))
        }
      }
    })

    socket.on('error', (err) => {
      clearTimeout(timeout)
      reject(new Error(`socket error: ${err.message}`))
    })

    socket.on('end', () => {
      clearTimeout(timeout)
      if (!buf.trim()) reject(new Error('daemon closed connection without response'))
    })
  })
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

export function printResponse(response: Record<string, unknown>, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(response, null, 2))
    return
  }

  if (!response.ok) {
    console.error(`error: ${response.error}${response.result === 'deferred' ? ' [deferred]' : ''}`)
    process.exit(typeof response.exitCode === 'number' ? response.exitCode : 1)
  }

  const data = response.data as any
  const command = response.command as string | undefined

  if (!data) {
    console.log('ok')
    return
  }

  switch (command) {
    case 'list': {
      const items = data as any[]
      if (items.length === 0) { console.log('(none)'); return }
      for (const item of items) {
        const status = item.status === 'connected' ? '●' : '○'
        const ctx = item.context ? ` [${item.context}]` : ''
        const cpu = item.cpu ? ` · ${item.cpu}` : ''
        console.log(`${status} ${item.name}  ${item.description ?? ''}  (${item.running_for}${ctx}${cpu})`)
      }
      return
    }
    case 'spawn':
      console.log(`spawned: ${data.name} (${data.sessionId})`)
      if (data.url) console.log(`thread:  ${data.url}`)
      if (data.idempotencyKey) console.log(`key:     ${data.idempotencyKey}`)
      return
    case 'kill':
      console.log(`killed: ${data.killed}`)
      return
    case 'health':
      console.log(`sessions: ${data.sessions.total} (${data.sessions.connected} connected, ${data.sessions.disconnected} disconnected)`)
      console.log(`tmux: ${data.tmux}`)
      console.log(`idempotency: ${data.idempotency.active} active keys`)
      if (data.loopLagMaxMs !== undefined) {
        const s = data.loopLastStall
        console.log(`event loop: worst lag ${data.loopLagMaxMs}ms since start${s ? `; last stall ${s.ms}ms${s.callback ? ` (${s.callback} held it ${s.callbackMs}ms)` : ''} at ${s.at}` : ''}`)
      }
      if (data.raindrop) console.log(`raindrop: ${data.raindrop}`)
      for (const r of data.refusedLaunches ?? []) console.log(`restricted specialist ${r.specialist}: launch REFUSED ${r.ageMin} min ago (${r.why}) · fix: send it another message to start a fresh session; if it repeats, the cause is in the engine's launch record (Claude Code: its debug file), not hydra.toml`)
      if (data.macosGate) console.log(`${data.macosGate.allowed ? 'WARNING' : 'REFUSED'}: restricted specialist${data.macosGate.specialists.length > 1 ? 's' : ''} ${data.macosGate.specialists.join(', ')}: ${macosGateIssue(data.macosGate.version, data.macosGate.allowed)}`)
      if (data.slack) for (const line of slackHealthLines(data.slack)) console.log(line)
      return
    case 'status':
      console.log(`${data.name} (${data.sessionId})`)
      console.log(`  topic:   ${data.topic}`)
      if (data.description) console.log(`  desc:    ${data.description}`)
      console.log(`  bridge:  ${data.bridge}`)
      console.log(`  tmux:    ${data.tmux}`)
      console.log(`  uptime:  ${data.running_for}`)
      if (data.context) console.log(`  context: ${data.context}`)
      if (data.cpu) console.log(`  cpu:     ${data.cpu}`)
      if (data.url) console.log(`  url:     ${data.url}`)
      if (data.origin) console.log(`  origin:  ${data.origin}`)
      return
    case 'clear-key':
      console.log(`cleared: ${data.cleared}`)
      return
    case 'deliver':
      console.log(`${data.status}: ${data.sessionName} (${data.proof})`)
      if (data.target) console.log(`delivers to ${data.target}`)
      return
    default:
      console.log(JSON.stringify(data, null, 2))
  }
}

// ---------------------------------------------------------------------------
// Daemon env string builder
// ---------------------------------------------------------------------------

export function requireSpawnCwd(cfg: HydraConfig): void {
  if (!cfg.spawnCwdBlank) return
  console.error('error: SPAWN_CWD is set but empty — every spawn and worktree would resolve against the wrong root')
  console.error(`give it a value in ${join(cfg.stateDir, '.env')}, or unset it to fall back to ${homedir()}`)
  process.exit(1)
}

/**
 * The env a daemon's tmux session starts with. PATH leads with the pinned bun's directory, so `bun run daemon.ts`
 * and every bare `bun` the daemon starts in turn (bridges, job attempts) run the pin, whatever bun the caller ran.
 */
export function buildDaemonEnvs(cfg: HydraConfig, bun: { path: string; fallback?: string } = pinnedBun(cfg.hydraDir)): string {
  if (bun.fallback) {
    appendLog(cfg.daemonLog, bun.fallback)
    console.error(`warning: ${bun.fallback}`)
  }
  const path = bun.path.includes('/') ? `${dirname(bun.path)}:${process.env.PATH}` : process.env.PATH
  const envs = [
    `PATH=${shq(path ?? '')}`,
    `HYDRA_STATE_DIR=${shq(cfg.stateDir)}`,
    `SPAWN_CWD=${shq(cfg.spawnCwdBlank ? '' : cfg.spawnCwd)}`,
    `CHAT_PLATFORM=${shq(cfg.platform)}`,
    `CLAUDE_CONFIG_DIR=${shq(cfg.configDir)}`,
    // The daemon caps this file itself (observability.trimDaemonLog). Passing the
    // resolved path rather than letting the daemon re-derive it keeps one source of
    // truth with the `tee -a` target above — and the daemon truncates only a path it
    // was handed, never one it guessed.
    `HYDRA_LOG=${shq(cfg.daemonLog)}`,
    'HYDRA_AUTO_RECOVER=1',
  ]
  const model = process.env.HYDRA_MODEL?.trim()
  if (model) envs.push(`HYDRA_MODEL=${shq(model)}`)
  return envs.join(' ')
}

// ---------------------------------------------------------------------------
// The pinned bun
// ---------------------------------------------------------------------------

/** The bun version .tool-versions pins: the one file asdf, CI (setup-bun) and scripts/test.sh all read. */
export function pinnedBunVersion(hydraDir: string): string | null {
  try {
    return /^bun\s+(\S+)/m.exec(readFileSync(join(hydraDir, '.tool-versions'), 'utf8'))?.[1] ?? null
  } catch { return null }
}

export type BunIO = {
  version: string
  execPath: string
  asdfDir: string
  exists: (p: string) => boolean
  which: () => string | null
}

const bunIO = (): BunIO => ({
  version: Bun.version,
  execPath: process.execPath,
  asdfDir: process.env.ASDF_DATA_DIR || join(homedir(), '.asdf'),
  exists: existsSync,
  // Bun.which searches the PATH bun started with unless handed one, and resolveConfig edits process.env.PATH.
  which: () => Bun.which('bun', { PATH: process.env.PATH ?? '' }),
})

/**
 * The pinned bun's absolute path, for the daemon. Before, the daemon ran whichever bun led the caller's PATH, where
 * asdf had put the bun it chose by the caller's working directory: a restart typed outside the repo started the
 * daemon on the home directory's bun. When the pinned bun is not installed, the bun on PATH, with the reason in
 * `fallback`: a daemon on another bun beats no daemon.
 */
export function pinnedBun(hydraDir: string, io: BunIO = bunIO()): { path: string; fallback?: string } {
  const pin = pinnedBunVersion(hydraDir)
  if (pin && io.version === pin) return { path: io.execPath }
  const installed = pin ? join(io.asdfDir, 'installs', 'bun', pin, 'bin', 'bun') : null
  if (installed && io.exists(installed)) return { path: installed }
  const onPath = io.which() ?? 'bun'
  return {
    path: onPath,
    fallback: pin
      ? `bun ${pin} (.tool-versions) is not installed, so the daemon runs ${onPath}; install it: asdf install bun ${pin}`
      : `.tool-versions pins no bun, so the daemon runs ${onPath}`,
  }
}

type AppHealthView = { name?: string; state: string; downMin: number | null; lastActivityAgeMin: number | null; catchUp: { ok: boolean; ageMin: number; reason?: string } | null; missingScopes?: { option: string; any: string[] }[] | null; tokens?: { ok: boolean; why?: string }; probeError?: string }
type SlackHealthView = { listener?: AppHealthView; apps?: Record<string, AppHealthView>; conversations: number; readAsOperator: number; owed: number; oldestOwedAgeMin: number | null; owedLate?: { conversation: string; to?: string; count: number; oldestAgeMin: number; cause: string }[]; owedLateAfterMin?: number }

/**
 * `hydra health`'s Slack lines: one for the whole, as it always was, when the only app is `default`; with several (or one that
 * is not `default`), a header and a line for each app, with its name: connection, last event, catch-up and scope status.
 */
export function slackHealthLines(s: SlackHealthView): string[] {
  const catchUpOf = (l: AppHealthView | undefined) => l?.catchUp ? ` · catch-up ${l.catchUp.ok ? 'ok' : `failing (${l.catchUp.reason ?? 'see log'})`} ${l.catchUp.ageMin} min ago` : ''
  const stateOf = (l: AppHealthView | undefined) => !l ? 'off' : l.state === 'up' ? 'up' : `${l.state}${l.downMin !== null ? ` ${l.downMin} min` : ''}`
  const asOperator = s.readAsOperator ? ` (${s.readAsOperator} read as the operator)` : ''
  const owed = s.owed ? `${s.owed} owed, oldest ${s.oldestOwedAgeMin} min` : '0 owed'
  const conversations = `${s.conversations} conversation${s.conversations === 1 ? '' : 's'}${asOperator} · ${owed}`
  // What to do, said with the fact: Slack's reason names the scope; the fix is the manifest and a reinstall.
  const unreadable = (a: AppHealthView, id: string) => a.probeError ? [`membership unreadable (${a.probeError}) · fix: add the scope Slack names (hydra slack manifest ${id}), reinstall`] : []
  const late = (s.owedLate ?? []).map(o => `  owed ${o.count} to ${o.to ?? 'no target'} in ${o.conversation}, oldest ${o.oldestAgeMin} min (past ${s.owedLateAfterMin ?? '?'} min): ${o.cause}`)
  const ids = Object.keys(s.apps ?? {})
  if (ids.length <= 1 && (ids.length === 0 || ids[0] === 'default')) {
    const l = s.listener
    const lacks = l?.missingScopes?.length ? ` · missing ${l.missingScopes.map(m => `${m.any.join(' or ')} (${m.option})`).join('; ')}` : ''
    return [`slack connector: ${stateOf(l)}${catchUpOf(l)} · ${conversations}${lacks}`, ...(l ? unreadable(l, 'default').map(x => `  ${l.name ?? 'default'}: ${x}`) : []), ...late]
  }
  const lines = [`slack connector: ${ids.length} app${ids.length === 1 ? '' : 's'} · ${conversations}`]
  for (const id of ids) {
    const a = s.apps![id]
    const parts = a.tokens && !a.tokens.ok ? [`off · ${a.tokens.why}`] : [
      stateOf(a),
      ...(a.lastActivityAgeMin !== null ? [`last event ${a.lastActivityAgeMin} min ago`] : []),
      catchUpOf(a).replace(/^ · /, '') || 'catch-up not yet run',
      a.missingScopes === null || a.missingScopes === undefined ? 'scopes unchecked' : a.missingScopes.length ? `missing ${a.missingScopes.map(m => `${m.any.join(' or ')} (${m.option})`).join('; ')}` : 'scopes ok',
      ...unreadable(a, id),
    ]
    lines.push(`  ${a.name ?? id}: ${parts.join(' · ')}`)
  }
  return [...lines, ...late]
}

/** The chat platform a state dir belongs to: the one named, else the one the dir is called, else what the caller resolved (`cfg.platform`), else CHAT_PLATFORM. */
export function statePlatform(stateDir: string, explicit?: string, resolved?: string): 'discord' | 'slack' {
  const named = ['discord', 'slack'].includes(basename(stateDir)) ? basename(stateDir) : undefined
  return (explicit ?? named ?? resolved ?? process.env.CHAT_PLATFORM) === 'slack' ? 'slack' : 'discord'
}
