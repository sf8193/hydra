import { connect } from 'net'
import { existsSync, readdirSync, statSync, unlinkSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { execSync, execFileSync } from 'child_process'
import { spawnModel, TRANSCRIBE_TMUX } from '../shared/constants.js'
import { withRaisedFdLimit } from '../shared/tmux-env.js'

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
  byteModel: string
  byteAuth: 'auto' | 'keychain'
  byteCwd: string
  byteChannel: string
  socketTimeout: number
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

  if (!platform) {
    const channelsDir = join(homedir(), '.claude', 'channels')
    try {
      const dirs = readdirSync(channelsDir).filter(d => {
        try { return statSync(join(channelsDir, d)).isDirectory() } catch { return false }
      })
      if (dirs.length === 1) {
        platform = dirs[0]
      } else if (dirs.length > 1) {
        console.error(`error: CHAT_PLATFORM not set and ${dirs.length} platform state dirs exist`)
        console.error('set platform explicitly (e.g. hydra up discord)')
        process.exit(1)
      }
    } catch {}
    if (!platform) platform = 'discord'
  }

  const stateDir = process.env.HYDRA_STATE_DIR ?? process.env.DISCORD_STATE_DIR ?? join(homedir(), '.claude', 'channels', platform)
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  const spawnCwd = process.env.SPAWN_CWD ?? homedir()

  // Source .env from state dir (mirrors env-setup.sh)
  const envFile = join(stateDir, '.env')
  if (existsSync(envFile)) {
    const content = readFileSync(envFile, 'utf-8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq === -1) continue
      const key = trimmed.slice(0, eq)
      let val = trimmed.slice(eq + 1)
      // Strip surrounding quotes. Does NOT handle escape sequences (\", \n) or
      // multiline values — if .env files grow beyond simple key=value, use dotenv.
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1)
      }
      if (!(key in process.env)) {
        process.env[key] = val
      }
    }
  }

  return {
    platform,
    stateDir,
    configDir,
    spawnCwd: process.env.SPAWN_CWD ?? spawnCwd,
    hydraDir,
    daemonTmux: `${platform}-daemon`,
    byteTmux: process.env.BYTE_SESSION_NAME ?? `${platform}-byte`,
    transcribeTmux: TRANSCRIBE_TMUX,
    daemonLog: process.env.HYDRA_LOG ?? join(homedir(), `hydra-${platform}-daemon.log`),
    byteLog: process.env.HYDRA_BYTE_LOG ?? join(homedir(), `hydra-${platform}-byte.log`),
    watchdogLog: process.env.HYDRA_WATCHDOG_LOG ?? join(homedir(), 'hydra-watchdog.log'),
    sockPath: join(stateDir, 'daemon.sock'),
    byteModel: spawnModel(),
    byteAuth: (process.env.HYDRA_AUTH?.trim() ?? 'auto') === 'keychain' ? 'keychain' : 'auto',
    byteCwd: process.env.BYTE_CWD ?? spawnCwd,
    byteChannel: process.env.BYTE_CHANNEL ?? '',
    socketTimeout: Math.max(Number(process.env.HYDRA_SOCKET_TIMEOUT) || 15_000, 1_000),
  }
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
  execFileSync('tmux', ['new-session', '-d', '-s', name, withRaisedFdLimit(command)], { stdio: 'pipe', env: execEnv() })
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

export function resolveSocket(daemonName?: string): string {
  const discovered = discoverSockets()
  const keys = Object.keys(discovered)

  if (daemonName) {
    if (discovered[daemonName]) return discovered[daemonName]
    console.error(`error: daemon "${daemonName}" not found`)
    console.error(`discovered: ${keys.join(', ') || '(none)'}`)
    process.exit(1)
  }

  if (keys.length === 1) return discovered[keys[0]]
  if (keys.length === 0) {
    console.error('error: no running daemons found')
    process.exit(1)
  }

  console.error(`error: multiple daemons found: ${keys.join(', ')}`)
  console.error('use --daemon <name> to select one')
  process.exit(1)
}

export function sendRequest(socketPath: string, request: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    let buf = ''
    const timeout = setTimeout(() => {
      socket.destroy()
      reject(new Error('connection timed out'))
    }, 10_000)

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
    console.error(`error: ${response.error}`)
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
        console.log(`${status} ${item.name}  ${item.description ?? ''}  (${item.running_for}${ctx})`)
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
      return
    case 'status':
      console.log(`${data.name} (${data.sessionId})`)
      console.log(`  topic:   ${data.topic}`)
      if (data.description) console.log(`  desc:    ${data.description}`)
      console.log(`  bridge:  ${data.bridge}`)
      console.log(`  tmux:    ${data.tmux}`)
      console.log(`  uptime:  ${data.running_for}`)
      if (data.context) console.log(`  context: ${data.context}`)
      if (data.url) console.log(`  url:     ${data.url}`)
      if (data.origin) console.log(`  origin:  ${data.origin}`)
      return
    case 'clear-key':
      console.log(`cleared: ${data.cleared}`)
      return
    case 'factory': {
      if (data.accepted) { console.log(`accepted: ${data.accepted}`); return }
      if (data.abandoned) { console.log(`abandoned: ${data.abandoned}`); return }
      const builds = (data.builds ?? []) as any[]
      if (builds.length === 0) { console.log('(no active builds)'); return }
      for (const b of builds) {
        const secs = Math.round((b.elapsed ?? 0) / 1000)
        const wt = b.worktree ? ` wt:${b.worktree}` : ''
        const builder = b.builderName ? ` builder:${b.builderName}` : ''
        console.log(`${b.ticket}  ${b.phase}  (${secs}s, retries:${b.retries}${builder}${wt})`)
        if (b.spec) console.log(`    ${b.spec.split('\n')[0].slice(0, 100)}`)
      }
      return
    }
    default:
      console.log(JSON.stringify(data, null, 2))
  }
}

// ---------------------------------------------------------------------------
// Daemon env string builder
// ---------------------------------------------------------------------------

export function buildDaemonEnvs(cfg: HydraConfig): string {
  return [
    `PATH='${process.env.PATH}'`,
    `HYDRA_STATE_DIR=${shq(cfg.stateDir)}`,
    `SPAWN_CWD=${shq(cfg.spawnCwd)}`,
    `CHAT_PLATFORM=${shq(cfg.platform)}`,
    `CLAUDE_CONFIG_DIR=${shq(cfg.configDir)}`,
  ].join(' ')
}
