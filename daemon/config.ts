import {
  readFileSync,
  chmodSync,
} from 'fs'
import { homedir } from 'os'
import { join } from 'path'

import type { ChatGateway } from '../gateway.js'
import { parseEnvLine } from '../shared/env-parse.js'

// ---------------------------------------------------------------------------
// Paths & env
// ---------------------------------------------------------------------------

export const STATE_DIR = process.env.HYDRA_STATE_DIR
  ?? process.env.DISCORD_STATE_DIR
  ?? join(homedir(), '.claude', 'channels', process.env.CHAT_PLATFORM ?? 'discord')
export const ACCESS_FILE = join(STATE_DIR, 'access.json')
export const APPROVED_DIR = join(STATE_DIR, 'approved')
export const ENV_FILE = join(STATE_DIR, '.env')
export const SOCK_PATH = join(STATE_DIR, 'daemon.sock')
export const INBOX_DIR = join(STATE_DIR, 'inbox')

export const CLAUDE_CONFIG = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude-personal')

const LOCAL_ENV_FILE = join(import.meta.dir, '..', '.env')
for (const envFile of [LOCAL_ENV_FILE, ENV_FILE]) {
  try {
    chmodSync(envFile, 0o600)
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const parsed = parseEnvLine(line)
      if (parsed && process.env[parsed[0]] === undefined) process.env[parsed[0]] = parsed[1]
    }
  } catch {}
}

// Read after .env sourcing — .env values must be available.
// If not set, resolveDefaultChannel() will auto-detect the bot's DM with the primary user.
export let DEFAULT_SESSION_CHANNEL = process.env.DEFAULT_SESSION_CHANNEL ?? ''

export async function resolveDefaultChannel(): Promise<void> {
  if (DEFAULT_SESSION_CHANNEL) return
  try {
    const { loadAccess } = await import('./access.js')
    const access = loadAccess()
    const userId = access.allowFrom[0]
    if (!userId) return
    if ('sendDM' in gateway) {
      const ch = await (gateway as any).app?.client?.conversations?.open({ users: userId })
      if (ch?.channel?.id) {
        DEFAULT_SESSION_CHANNEL = ch.channel.id
        process.stderr.write(`daemon: auto-resolved DEFAULT_SESSION_CHANNEL=${DEFAULT_SESSION_CHANNEL} (DM with ${userId})\n`)
        return
      }
    }
  } catch (err) {
    process.stderr.write(`daemon: failed to auto-resolve DEFAULT_SESSION_CHANNEL: ${err}\n`)
  }
  if (!DEFAULT_SESSION_CHANNEL) {
    process.stderr.write(`daemon: DEFAULT_SESSION_CHANNEL not set — spawns from home tab will fail.\n`)
  }
}

// ---------------------------------------------------------------------------
// Platform
// ---------------------------------------------------------------------------

export const PLATFORM = (process.env.CHAT_PLATFORM ?? 'discord') as 'discord' | 'slack'

let TOKEN: string | undefined
let SLACK_APP_TOKEN: string | undefined

if (PLATFORM === 'slack') {
  TOKEN = process.env.SLACK_BOT_TOKEN
  SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN
  if (!TOKEN || !SLACK_APP_TOKEN) {
    process.stderr.write(
      `daemon: SLACK_BOT_TOKEN and SLACK_APP_TOKEN required for slack platform\n` +
      `  set in ${ENV_FILE}\n`,
    )
    process.exit(1)
  }
} else {
  TOKEN = process.env.DISCORD_BOT_TOKEN
  if (!TOKEN) {
    process.stderr.write(
      `daemon: DISCORD_BOT_TOKEN required for discord platform\n` +
      `  set in ${ENV_FILE}\n`,
    )
    process.exit(1)
  }
}

export { TOKEN, SLACK_APP_TOKEN }

export const STATIC = process.env.DISCORD_ACCESS_MODE === 'static'

// ---------------------------------------------------------------------------
// Permission regex
// ---------------------------------------------------------------------------

export const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

// ---------------------------------------------------------------------------
// Safety nets
// ---------------------------------------------------------------------------

process.on('unhandledRejection', err => {
  process.stderr.write(`daemon: unhandled rejection: ${err}\n`)
})
process.on('uncaughtException', err => {
  process.stderr.write(`daemon: uncaught exception: ${err}\n`)
})

// ---------------------------------------------------------------------------
// Gateway (created here, wired by daemon.ts orchestrator)
// ---------------------------------------------------------------------------

export const heartbeatPath = join(STATE_DIR, 'daemon.alive')

export let gateway: ChatGateway

if (PLATFORM === 'slack') {
  const { SlackGateway } = await import('../slack-gateway.js')
  gateway = new SlackGateway(SLACK_APP_TOKEN!, { heartbeatPath })
} else {
  const { DiscordGateway } = await import('../discord-gateway.js')
  // DiscordGateway owns its heartbeat via GatewayHealth — written only while the
  // socket is actually connected, so a wedged transport goes stale for the watchdog.
  gateway = new DiscordGateway({ heartbeatPath })
}
