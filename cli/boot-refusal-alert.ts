// The watchdog finds a daemon that will not start because `hydra migrate` has not been run. The bot is silent in chat then, so the
// operator is told once in a direct message, through the platform's web API: it needs no connected gateway, only the bot token.

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { HYDRA_TOML } from '../config/migrate.js'

const envToken = (stateDir: string, key: string): string | undefined =>
  readFileSync(join(stateDir, '.env'), 'utf8').match(new RegExp(`^${key}=(.+)$`, 'm'))?.[1].trim().replace(/^["']|["']$/g, '')

/** The operator's id on this platform: the first allowFrom of access.json, or the operator's address in hydra.toml. */
export function operatorId(stateDir: string, platform: string): string | undefined {
  const access = join(stateDir, 'access.json')
  if (existsSync(access)) {
    const first = (JSON.parse(readFileSync(access, 'utf8')) as { allowFrom?: unknown[] }).allowFrom?.[0]
    if (first !== undefined) return String(first)
  }
  const toml = join(stateDir, HYDRA_TOML)
  if (!existsSync(toml)) return undefined
  const doc = Bun.TOML.parse(readFileSync(toml, 'utf8')) as { operator?: string; people?: Record<string, { addresses?: string[] }> }
  const address = doc.operator ? doc.people?.[doc.operator]?.addresses?.find(a => a.startsWith(`${platform}:`)) : undefined
  return address?.slice(platform.length + 1)
}

const post = async (url: string, token: string, body: object, bearer: string): Promise<any> =>
  (await fetch(url, { method: 'POST', headers: { Authorization: `${bearer} ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json()

/** Sends `text` to the operator's DM. Returns why it could not, or undefined. Never throws: an alert that fails is a log line. */
export async function alertOperator(stateDir: string, platform: string, text: string): Promise<string | undefined> {
  try {
    const user = operatorId(stateDir, platform)
    if (!user) return 'no operator id in access.json or hydra.toml'
    if (platform === 'slack') {
      const token = envToken(stateDir, 'SLACK_BOT_TOKEN')
      if (!token) return 'no SLACK_BOT_TOKEN in .env'
      const opened = await post('https://slack.com/api/conversations.open', token, { users: user }, 'Bearer')
      if (!opened.ok) return `conversations.open: ${opened.error}`
      const sent = await post('https://slack.com/api/chat.postMessage', token, { channel: opened.channel.id, text }, 'Bearer')
      return sent.ok ? undefined : `chat.postMessage: ${sent.error}`
    }
    const token = envToken(stateDir, 'DISCORD_BOT_TOKEN')
    if (!token) return 'no DISCORD_BOT_TOKEN in .env'
    const dm = await post('https://discord.com/api/v10/users/@me/channels', token, { recipient_id: user }, 'Bot')
    if (!dm.id) return `open DM: ${dm.message ?? 'failed'}`
    const sent = await post(`https://discord.com/api/v10/channels/${dm.id}/messages`, token, { content: text }, 'Bot')
    return sent.id ? undefined : `send: ${sent.message ?? 'failed'}`
  } catch (e) {
    return (e as Error).message
  }
}
