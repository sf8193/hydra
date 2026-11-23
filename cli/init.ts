// `hydra init <discord|slack> [--name <bot>] [--cwd <dir>] [--config-dir <dir>] [--operator <id>]`
// Guided first-time setup: validates tokens live, builds the Slack manifest URL or Discord invite link,
// pairs the operator by pasted ID or a 6-digit DM code, writes .env + hydra.toml, installs the bridge plugin,
// and runs `hydra install` (watchdog + CLI link + preflight).

import { randomInt } from 'crypto'
import { existsSync, lstatSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'
import { createInterface } from 'readline'
import { Writable } from 'stream'
import { formatIssues, loadHydraConfig } from '../config/load.js'
import { systemEnv } from '../infra/load-env.js'
import { SESSION_NAMES } from '../shared/session-catalog.js'
import { resolveConfig, tmuxExists } from './helpers.js'
import { lifecycleInstall, plistPath, type InstallOpts } from './lifecycle.js'

export type InitPlatform = 'discord' | 'slack'

// View Channels (10), Send Messages (11), Send Messages in Threads (38),
// Read Message History (16), Attach Files (15), Add Reactions (6) — docs/discord.md step 3.
const DISCORD_PERMISSIONS = '274878008384'
const DISCORD_GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json'
// DIRECT_MESSAGES (1 << 12) | MESSAGE_CONTENT (1 << 15)
const DISCORD_PAIR_INTENTS = (1 << 12) | (1 << 15)
const PAIR_TIMEOUT_MS = 120_000
const API_TIMEOUT_MS = 15_000

const SLACK_GATEWAY_SCOPES = [
  'app_mentions:read', 'assistant:write', 'channels:history', 'channels:read', 'chat:write',
  'files:read', 'files:write', 'groups:history', 'groups:read',
  'im:history', 'im:read', 'im:write', 'mpim:history',
  'reactions:read', 'reactions:write', 'users:read',
] as const

const SLACK_GATEWAY_EVENTS = [
  'app_home_opened', 'app_mention', 'message.channels', 'message.groups', 'message.im', 'reaction_added',
] as const

export function discordInviteUrl(applicationId: string): string {
  return `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(applicationId)}&scope=bot&permissions=${DISCORD_PERMISSIONS}`
}

/** Slack gateway app manifest (YAML) — matches docs/slack.md step 1 (App Home, Agent titles, Socket Mode, interactivity). */
export function slackGatewayManifest(botName: string): string {
  const name = botName.trim() || 'Hydra'
  const q = (s: string) => JSON.stringify(s)
  const list = (indent: string, items: readonly string[]) => items.map(i => `${indent}- ${i}`)
  return [
    'display_information:',
    `  name: ${q(name)}`,
    '  description: "Claude Code chat bridge"',
    '  background_color: "#2c2c2c"',
    'features:',
    '  app_home:',
    '    home_tab_enabled: true',
    '    messages_tab_enabled: true',
    '    messages_tab_read_only_enabled: false',
    '  bot_user:',
    `    display_name: ${q(name)}`,
    '    always_online: true',
    '  agent_view:',
    '    agent_description: "Claude Code chat bridge"',
    'oauth_config:',
    '  scopes:',
    '    bot:',
    ...list('      ', SLACK_GATEWAY_SCOPES),
    'settings:',
    '  event_subscriptions:',
    '    bot_events:',
    ...list('      ', SLACK_GATEWAY_EVENTS),
    '  interactivity:',
    '    is_enabled: true',
    '  org_deploy_enabled: false',
    '  socket_mode_enabled: true',
    '  token_rotation_enabled: false',
    '',
  ].join('\n')
}

/** Pre-filled Slack App creation link: opens Slack's "Create from manifest" flow with the YAML already populated. */
export function slackManifestUrl(manifestYaml: string): string {
  return `https://api.slack.com/apps?new_app=1&manifest_yaml=${encodeURIComponent(manifestYaml)}`
}

export function expandHome(dir: string, home: string = homedir()): string {
  const trimmed = dir.trim()
  if (trimmed === '~') return home
  if (trimmed.startsWith('~/')) return join(home, trimmed.slice(2))
  return resolve(trimmed)
}

export function envFile(platform: InitPlatform, tokens: { bot: string; app?: string }, spawnCwd: string, configDir?: string): string {
  const vars = platform === 'slack'
    ? [`SLACK_BOT_TOKEN=${tokens.bot}`, `SLACK_APP_TOKEN=${tokens.app ?? ''}`]
    : [`DISCORD_BOT_TOKEN=${tokens.bot}`]
  const lines = [`CHAT_PLATFORM=${platform}`, ...vars, `SPAWN_CWD='${spawnCwd}'`]
  if (configDir) lines.push(`CLAUDE_CONFIG_DIR='${configDir}'`)
  return [...lines, ''].join('\n')
}

/** Minimal valid hydra.toml for a single operator on `platform`. Tokens stay in `.env`. */
export function hydraToml(platform: InitPlatform, userId: string): string {
  return [
    'operator = "operator"',
    '',
    '[people.operator]',
    `addresses = [${JSON.stringify(`${platform}:${userId}`)}]`,
    '',
  ].join('\n')
}

export function generatePairingCode(): string {
  return String(randomInt(100_000, 1_000_000))
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export type DiscordVerifyResult =
  | { ok: true; applicationId: string; botUsername: string }
  | { ok: false; error: string }

const fetchSignal = (signal?: AbortSignal): AbortSignal =>
  signal ? AbortSignal.any([AbortSignal.timeout(API_TIMEOUT_MS), signal]) : AbortSignal.timeout(API_TIMEOUT_MS)

/** Verify a Discord bot token live and learn its Application ID + bot username for the invite URL. */
export async function verifyDiscordToken(botToken: string, fetchFn: FetchLike = fetch, signal?: AbortSignal): Promise<DiscordVerifyResult> {
  let resp: Response
  try {
    resp = await fetchFn('https://discord.com/api/v10/oauth2/applications/@me', {
      headers: { Authorization: `Bot ${botToken}` },
      signal: fetchSignal(signal),
    })
  } catch (err) {
    return { ok: false, error: `could not reach Discord API: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (!resp.ok) {
    return { ok: false, error: resp.status === 401 ? 'Discord rejected the bot token (401 Unauthorized)' : `Discord API returned HTTP ${resp.status}` }
  }
  let data: { id?: string; name?: string; bot?: { username?: string } }
  try { data = await resp.json() as typeof data } catch {
    return { ok: false, error: 'Discord API returned invalid JSON' }
  }
  if (!data.id) return { ok: false, error: 'Discord API response did not include an application ID' }
  return { ok: true, applicationId: data.id, botUsername: data.bot?.username || data.name || 'your bot' }
}

export type SlackVerifyResult =
  | { ok: true; botName: string; teamName: string }
  | { ok: false; error: string }

export type SlackSocketResult =
  | { ok: true; wsUrl: string }
  | { ok: false; error: string }

/** Request a fresh Socket Mode WebSocket URL from Slack (`apps.connections.open`). */
export async function openSlackSocket(appToken: string, fetchFn: FetchLike = fetch, signal?: AbortSignal): Promise<SlackSocketResult> {
  let connResp: Response
  try {
    connResp = await fetchFn('https://slack.com/api/apps.connections.open', {
      method: 'POST',
      headers: { Authorization: `Bearer ${appToken}` },
      signal: fetchSignal(signal),
    })
  } catch (err) {
    return { ok: false, error: `could not reach Slack API (apps.connections.open): ${err instanceof Error ? err.message : String(err)}` }
  }
  if (!connResp.ok) return { ok: false, error: `Slack apps.connections.open returned HTTP ${connResp.status}` }
  let connData: { ok?: boolean; error?: string; url?: string }
  try { connData = await connResp.json() as typeof connData } catch {
    return { ok: false, error: 'Slack apps.connections.open returned invalid JSON' }
  }
  if (!connData.ok || !connData.url) {
    return { ok: false, error: `Slack app-level token rejected (${connData.error || 'missing socket URL'}) — check Socket Mode and connections:write scope` }
  }
  return { ok: true, wsUrl: connData.url }
}

/** Verify both Slack tokens live: xoxb- via auth.test, xapp- via apps.connections.open. */
export async function verifySlackTokens(botToken: string, appToken: string, fetchFn: FetchLike = fetch, signal?: AbortSignal): Promise<SlackVerifyResult> {
  if (!botToken.startsWith('xoxb-')) return { ok: false, error: 'bot token must start with xoxb-' }
  if (!appToken.startsWith('xapp-')) return { ok: false, error: 'app-level token must start with xapp-' }

  let authResp: Response
  try {
    authResp = await fetchFn('https://slack.com/api/auth.test', {
      method: 'POST',
      headers: { Authorization: `Bearer ${botToken}` },
      signal: fetchSignal(signal),
    })
  } catch (err) {
    return { ok: false, error: `could not reach Slack API (auth.test): ${err instanceof Error ? err.message : String(err)}` }
  }
  if (!authResp.ok) return { ok: false, error: `Slack auth.test returned HTTP ${authResp.status}` }
  let authData: { ok?: boolean; error?: string; user?: string; team?: string }
  try { authData = await authResp.json() as typeof authData } catch {
    return { ok: false, error: 'Slack auth.test returned invalid JSON' }
  }
  if (!authData.ok) return { ok: false, error: `Slack bot token rejected (${authData.error || 'unknown error'})` }

  const conn = await openSlackSocket(appToken, fetchFn, signal)
  if (!conn.ok) return conn

  return { ok: true, botName: authData.user || 'your bot', teamName: authData.team || 'your workspace' }
}

/** Minimal WebSocket surface needed for one-shot DM pairing (real WebSocket or a test fake). */
export interface PairingSocket {
  send(data: string): void
  close(): void
  addEventListener(type: 'message', listener: (ev: { data: unknown }) => void): void
  addEventListener(type: 'close', listener: (ev: { code?: number; reason?: string }) => void): void
  addEventListener(type: 'error', listener: (ev: unknown) => void): void
}

export type SocketFactory = (url: string) => PairingSocket

export type PairResult =
  | { ok: true; userId: string; username?: string }
  | { ok: false; error: string }

function rawMessageText(data: unknown): string | null {
  if (typeof data === 'string') return data
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data)
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data)
  return null
}

/** Wait for a Discord DM containing `code`; returns the sender's Discord user ID (or detects 4014 disabled Message Content Intent). */
export function pairDiscordOperator(
  botToken: string,
  code: string,
  opts: { timeoutMs?: number; createSocket?: SocketFactory; signal?: AbortSignal } = {},
): Promise<PairResult> {
  if (opts.signal?.aborted) return Promise.resolve({ ok: false, error: 'input closed before setup finished' })
  const timeoutMs = opts.timeoutMs ?? PAIR_TIMEOUT_MS
  const createSocket = opts.createSocket ?? ((url: string) => new WebSocket(url) as unknown as PairingSocket)
  return new Promise(resolvePair => {
    let settled = false
    let heartbeat: ReturnType<typeof setInterval> | null = null
    let lastSeq: number | null = null
    let ws: PairingSocket
    const onAbort = () => finish({ ok: false, error: 'input closed before setup finished' })
    const finish = (result: PairResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (heartbeat) clearInterval(heartbeat)
      opts.signal?.removeEventListener('abort', onAbort)
      try { ws?.close() } catch {}
      resolvePair(result)
    }
    const timer = setTimeout(() => finish({ ok: false, error: `timed out waiting for DM code "${code}"` }), timeoutMs)
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    try { ws = createSocket(DISCORD_GATEWAY_URL) } catch (err) {
      finish({ ok: false, error: `could not open Discord gateway: ${err instanceof Error ? err.message : String(err)}` })
      return
    }
    ws.addEventListener('message', ev => {
      const raw = rawMessageText(ev.data)
      if (!raw) return
      let pkt: {
        op?: number
        t?: string
        s?: number | null
        d?: {
          heartbeat_interval?: number
          guild_id?: unknown
          content?: unknown
          author?: { id?: unknown; username?: string; bot?: unknown }
        }
      }
      try { pkt = JSON.parse(raw) } catch { return }
      if (typeof pkt.s === 'number') lastSeq = pkt.s
      if (pkt.op === 10 && pkt.d?.heartbeat_interval) {
        const interval = Number(pkt.d.heartbeat_interval)
        if (interval > 0) {
          heartbeat = setInterval(() => { try { ws.send(JSON.stringify({ op: 1, d: lastSeq })) } catch {} }, interval)
        }
        ws.send(JSON.stringify({
          op: 2,
          d: {
            token: botToken,
            intents: DISCORD_PAIR_INTENTS,
            properties: { os: process.platform, browser: 'hydra-init', device: 'hydra-init' },
          },
        }))
        return
      }
      if (pkt.op === 0 && pkt.t === 'MESSAGE_CREATE') {
        const m = pkt.d
        if (!m || m.guild_id || m.author?.bot) return
        if (typeof m.content === 'string' && m.content.trim() === code && typeof m.author?.id === 'string') {
          finish({ ok: true, userId: m.author.id, username: m.author.username })
        }
      }
    })
    ws.addEventListener('close', ev => {
      if (ev.code === 4014) {
        finish({ ok: false, error: 'Message Content Intent is disabled — enable it in Discord Developer Portal → Bot → Privileged Gateway Intents, then retry' })
      } else {
        finish({ ok: false, error: `Discord gateway closed (${ev.code ?? 'unknown'}${ev.reason ? `: ${ev.reason}` : ''})` })
      }
    })
    ws.addEventListener('error', () => {
      finish({ ok: false, error: 'Discord gateway connection failed' })
    })
  })
}

/** Wait for a Slack DM containing `code` over a one-shot Socket Mode connection; returns the sender's Slack member ID. */
export function pairSlackOperator(
  wsUrl: string,
  code: string,
  opts: { timeoutMs?: number; createSocket?: SocketFactory; signal?: AbortSignal } = {},
): Promise<PairResult> {
  if (opts.signal?.aborted) return Promise.resolve({ ok: false, error: 'input closed before setup finished' })
  const timeoutMs = opts.timeoutMs ?? PAIR_TIMEOUT_MS
  const createSocket = opts.createSocket ?? ((url: string) => new WebSocket(url) as unknown as PairingSocket)
  return new Promise(resolvePair => {
    let settled = false
    let ws: PairingSocket
    const onAbort = () => finish({ ok: false, error: 'input closed before setup finished' })
    const finish = (result: PairResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      try { ws?.close() } catch {}
      resolvePair(result)
    }
    const timer = setTimeout(() => finish({ ok: false, error: `timed out waiting for DM code "${code}"` }), timeoutMs)
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    try { ws = createSocket(wsUrl) } catch (err) {
      finish({ ok: false, error: `could not open Slack Socket Mode connection: ${err instanceof Error ? err.message : String(err)}` })
      return
    }
    ws.addEventListener('message', ev => {
      const raw = rawMessageText(ev.data)
      if (!raw) return
      let pkt: {
        envelope_id?: string
        payload?: {
          event?: {
            type?: unknown
            channel_type?: unknown
            bot_id?: unknown
            subtype?: unknown
            text?: unknown
            user?: unknown
          }
        }
      }
      try { pkt = JSON.parse(raw) } catch { return }
      if (pkt.envelope_id) {
        try { ws.send(JSON.stringify({ envelope_id: pkt.envelope_id })) } catch {}
      }
      const event = pkt.payload?.event
      if (!event || event.type !== 'message' || event.channel_type !== 'im' || event.bot_id || event.subtype) return
      if (typeof event.text === 'string' && event.text.trim() === code && typeof event.user === 'string') {
        finish({ ok: true, userId: event.user })
      }
    })
    ws.addEventListener('close', ev => {
      finish({ ok: false, error: `Slack Socket Mode closed (${ev.code ?? 'unknown'}${ev.reason ? `: ${ev.reason}` : ''})` })
    })
    ws.addEventListener('error', () => {
      finish({ ok: false, error: 'Slack Socket Mode connection failed' })
    })
  })
}

export type InitOptions = {
  name?: string
  cwd?: string
  configDir?: string
  operator?: string
}

export class InputClosedError extends Error {
  constructor() { super('input closed before setup finished') }
}

export type InitIO = {
  ask: (prompt: string, opts?: { secret?: boolean }) => Promise<string>
  close: () => void
  log: (line: string) => void
  error: (line: string) => void
  fetch: FetchLike
  createSocket: SocketFactory
  generateCode: () => string
  installPlugin: (configDir: string) => boolean
  installWatchdog: (platform: InitPlatform, opts: InstallOpts) => Promise<void>
  stateDir: string
  configDir: string
  home: string
  plistPath: string
  daemonRunning: () => boolean
  signal?: AbortSignal
}

function defaultIO(platform: InitPlatform): InitIO {
  const cfg = resolveConfig(platform)
  const isTTY = Boolean(process.stdin.isTTY)
  let muted = false
  const out = new Writable({
    write(chunk, enc, cb) {
      if (!muted) process.stdout.write(chunk, enc)
      cb()
    },
  })
  const rl = createInterface({ input: process.stdin, output: out, terminal: isTTY })
  // Queue lines as they arrive so piped multi-line input is not dropped between async prompts (e.g. token verification).
  const queued: string[] = []
  let waiter: { resolve: (line: string) => void; reject: (err: Error) => void } | null = null
  let closed = false
  let expectedClose = false
  const ac = new AbortController()
  rl.on('line', line => {
    if (waiter) {
      const w = waiter
      waiter = null
      w.resolve(line)
    } else {
      queued.push(line)
    }
  })
  rl.on('close', () => {
    closed = true
    // Only abort in-flight network/pairing steps on an interactive TTY close (Ctrl-C / Ctrl-D);
    // piped stdin naturally hits EOF right after buffering its lines, before token verification runs.
    if (isTTY && !expectedClose) ac.abort(new InputClosedError())
    if (waiter) {
      const w = waiter
      waiter = null
      w.reject(new InputClosedError())
    }
  })
  return {
    ask: async (q, opts) => {
      if (queued.length > 0) {
        process.stdout.write(q)
        return queued.shift()!.trim()
      }
      if (closed) {
        process.stdout.write(`${q}\n`)
        throw new InputClosedError()
      }
      const hide = Boolean(opts?.secret && isTTY)
      if (hide) {
        rl.setPrompt('')
        process.stdout.write(q)
        muted = true
      } else if (isTTY) {
        // Let readline own the prompt on a TTY so Backspace/line redraw preserves the question instead of drawing `> `.
        rl.setPrompt(q)
        rl.prompt()
      } else {
        process.stdout.write(q)
      }
      try {
        const line = await new Promise<string>((resolveLine, rejectLine) => {
          waiter = { resolve: resolveLine, reject: rejectLine }
        })
        return line.trim()
      } catch (err) {
        if (!muted) process.stdout.write('\n')
        throw err
      } finally {
        if (muted) { muted = false; process.stdout.write('\n') }
        else if (isTTY) rl.setPrompt('')
      }
    },
    close: () => { expectedClose = true; rl.close() },
    log: line => console.log(line),
    error: line => console.error(line),
    fetch,
    createSocket: url => new WebSocket(url) as unknown as PairingSocket,
    generateCode: generatePairingCode,
    installPlugin: configDir => {
      try {
        const r = Bun.spawnSync(['claude', 'plugin', 'install', 'discord@claude-plugins-official'], {
          stdout: 'inherit',
          stderr: 'inherit',
          env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
        })
        return r.exitCode === 0
      } catch {
        return false
      }
    },
    installWatchdog: (p, opts) => lifecycleInstall(p, opts),
    stateDir: cfg.stateDir,
    configDir: cfg.configDir,
    home: homedir(),
    plistPath: plistPath(platform),
    daemonRunning: () => tmuxExists(cfg.daemonTmux),
    signal: ac.signal,
  }
}

export async function initPlatform(
  platform: InitPlatform,
  opts: InitOptions = {},
  io: InitIO = defaultIO(platform),
): Promise<number> {
  const stateDir = io.stateDir
  const configDir = opts.configDir ? expandHome(opts.configDir, io.home) : io.configDir
  const fail = (msg: string): number => {
    io.close()
    io.error(`error: ${msg}; nothing written`)
    return 1
  }

  if (opts.configDir && /[\r\n']/.test(configDir)) {
    return fail('config directory must be a single-line path without single quotes')
  }

  for (const file of ['.env', 'hydra.toml']) {
    const p = join(stateDir, file)
    let present = false
    try { lstatSync(p); present = true } catch {}
    if (present) {
      return fail(`${p} already exists — edit it or move it aside to start over`)
    }
  }
  {
    let plistPresent = false
    try { lstatSync(io.plistPath); plistPresent = true } catch {}
    if (plistPresent) {
      return fail(`${io.plistPath} already exists — run \`hydra uninstall ${platform}\` first to start over`)
    }
  }
  if (io.daemonRunning()) {
    return fail(`${platform}-daemon is already running — stop it with \`hydra down ${platform}\` first`)
  }

  let tokens: { bot: string; app?: string }
  let botLabel: string
  let userId = opts.operator?.trim() || ''
  let cwd: string

  try {
    if (platform === 'slack') {
      const botName = opts.name || await io.ask('Bot name (unique in your Slack workspace) [Hydra]: ') || 'Hydra'
      const manifest = slackGatewayManifest(botName)
      io.log('\n1. Open this link to create your Slack app with all scopes pre-filled:\n')
      io.log(`   ${slackManifestUrl(manifest)}\n`)
      io.log('   (Or paste the manifest manually at api.slack.com/apps → Create New App → From a manifest:)\n')
      io.log(manifest)
      io.log('2. Basic Information → App-Level Tokens → Generate (scope: connections:write) → copy xapp- token.')
      io.log('3. Install App → Install to Workspace → copy Bot User OAuth Token (xoxb-).\n')
      const appToken = await io.ask('App-level token (xapp-…): ', { secret: true })
      const botToken = await io.ask('Bot token (xoxb-…): ', { secret: true })
      if (/[\r\n]/.test(appToken) || /[\r\n]/.test(botToken)) return fail('tokens must be single-line values')
      io.log('Verifying Slack tokens...')
      const v = await verifySlackTokens(botToken, appToken, io.fetch, io.signal)
      if (io.signal?.aborted) return fail('input closed before setup finished')
      if (!v.ok) return fail(v.error)
      io.log(`  ✓ Connected to ${v.teamName} as @${v.botName}\n`)
      tokens = { bot: botToken, app: appToken }
      botLabel = `@${v.botName}`
    } else {
      io.log('\n1. Go to https://discord.com/developers/applications → New Application.')
      io.log('2. Bot → enable Message Content Intent → Reset Token → copy the bot token.\n')
      const botToken = await io.ask('Discord bot token: ', { secret: true })
      if (!botToken || /[\r\n]/.test(botToken)) return fail('need a single-line Discord bot token')
      io.log('Verifying Discord token...')
      const v = await verifyDiscordToken(botToken, io.fetch, io.signal)
      if (io.signal?.aborted) return fail('input closed before setup finished')
      if (!v.ok) return fail(v.error)
      io.log(`  ✓ Verified bot @${v.botUsername} (app ${v.applicationId})\n`)
      io.log('3. Open this link to add the bot to a server (needed so you can DM it):\n')
      io.log(`   ${discordInviteUrl(v.applicationId)}\n`)
      await io.ask('Press Enter once the bot is in your server: ')
      tokens = { bot: botToken }
      botLabel = `@${v.botUsername}`
    }

    if (!userId) {
      const idHint = platform === 'slack' ? 'Slack member ID' : 'Discord user ID'
      userId = await io.ask(`Your ${idHint} (or press Enter to pair by DMing ${botLabel}): `)
      if (!userId) {
        let freshSlackWsUrl: string | undefined
        if (platform === 'slack') {
          const fresh = await openSlackSocket(tokens.app!, io.fetch, io.signal)
          if (io.signal?.aborted) return fail('input closed before setup finished')
          if (!fresh.ok) return fail(fresh.error)
          freshSlackWsUrl = fresh.wsUrl
        }
        const code = io.generateCode()
        io.log(`\nDM ${botLabel} this 6-digit code: ${code}`)
        io.log('Waiting up to 2 minutes...')
        const paired = platform === 'slack'
          ? await pairSlackOperator(freshSlackWsUrl!, code, { createSocket: io.createSocket, signal: io.signal })
          : await pairDiscordOperator(tokens.bot, code, { createSocket: io.createSocket, signal: io.signal })
        if (io.signal?.aborted) return fail('input closed before setup finished')
        if (!paired.ok) return fail(paired.error)
        userId = paired.userId
        io.log(`  ✓ Paired operator ${platform}:${userId}${paired.username ? ` (${paired.username})` : ''}\n`)
      }
    }

    const tomlCheck = loadHydraConfig(hydraToml(platform, userId), systemEnv(SESSION_NAMES, stateDir, platform, configDir))
    if (!tomlCheck.ok) return fail(`hydra.toml would not load:\n${formatIssues(tomlCheck.errors)}`)

    const rawCwd = opts.cwd || await io.ask(`Work directory for spawned sessions [${io.home}]: `) || io.home
    if (io.signal?.aborted) return fail('input closed before setup finished')
    if (/[\r\n']/.test(rawCwd)) return fail('work directory must be a single-line path without single quotes')
    cwd = expandHome(rawCwd, io.home)
    if (/[\r\n']/.test(cwd)) return fail('work directory must be a single-line path without single quotes')
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      return fail(`work directory does not exist or is not a folder: ${cwd}`)
    }
  } catch (err) {
    if (err instanceof InputClosedError) return fail(err.message)
    throw err
  }

  const toml = hydraToml(platform, userId)
  io.close()
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const envPath = join(stateDir, '.env')
  const tomlPath = join(stateDir, 'hydra.toml')
  try {
    writeFileSync(envPath, envFile(platform, tokens, cwd, opts.configDir ? configDir : undefined), { mode: 0o600, flag: 'wx' })
  } catch (err) {
    io.error(`error: could not write ${envPath}: ${err instanceof Error ? err.message : String(err)}; nothing written`)
    return 1
  }
  try {
    writeFileSync(tomlPath, toml, { mode: 0o600, flag: 'wx' })
  } catch (err) {
    try { unlinkSync(envPath) } catch {}
    io.error(`error: could not write ${tomlPath}: ${err instanceof Error ? err.message : String(err)}; rolled back ${envPath}`)
    return 1
  }
  io.log(`wrote ${envPath} and ${tomlPath}`)

  if (!io.installPlugin(configDir)) {
    io.error('warning: bridge plugin install failed — run: claude plugin install discord@claude-plugins-official')
  }

  // Print before installWatchdog, because lifecyclePreflight exits non-zero on a fresh machine (e.g. Claude login/onboarding not done yet).
  io.log(`\nRunning install + preflight next. A failed preflight is normal on a fresh machine (e.g. Claude login/onboarding).`)
  io.log(`Fix any ✗ items, run \`claude\` once in a terminal if flagged, then re-run \`hydra preflight ${platform}\` and \`hydra up ${platform}\`.\n`)
  await io.installWatchdog(platform, { cwd, ...(opts.configDir ? { configDir } : {}) })
  return 0
}
