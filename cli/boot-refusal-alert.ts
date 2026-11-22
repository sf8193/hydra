// The watchdog finds a daemon that will not start because `hydra migrate` has not been run. The bot is silent in chat then, so the
// operator is told once in a direct message, through the platform's web API: it needs no connected gateway, only the bot token.

import { readFileSync } from 'fs'
import { join } from 'path'
import { HYDRA_TOML } from '../config/migrate.js'
import { finishOperatorAlert, shouldAlertOperator, startOperatorAlert } from './boot-refusal.js'
import { readEnvFileValue } from './helpers.js'

const envToken = (stateDir: string, key: string): string | undefined => readEnvFileValue(join(stateDir, '.env'), key)?.trim() || undefined

/**
 * The operator's id on this platform: the operator's address in hydra.toml when it names one (it governs once it does), else the
 * first allowFrom of access.json. Each file is read raw, so a hydra.toml that does not load, or an access.json that does not parse,
 * does not hide the other.
 */
export function operatorId(stateDir: string, platform: string): string | undefined {
  const toml = join(stateDir, HYDRA_TOML)
  try {
    const doc = Bun.TOML.parse(readFileSync(toml, 'utf8')) as { operator?: string; people?: Record<string, { addresses?: string[] }> }
    const address = doc.operator ? doc.people?.[doc.operator]?.addresses?.find(a => a.startsWith(`${platform}:`)) : undefined
    if (address) return address.slice(platform.length + 1)
  } catch {}
  try {
    const first = (JSON.parse(readFileSync(join(stateDir, 'access.json'), 'utf8')) as { allowFrom?: unknown[] }).allowFrom?.[0]
    if (first !== undefined) return String(first)
  } catch {}
  return undefined
}

const post = async (url: string, token: string, body: object, bearer: string): Promise<any> =>
  (await fetch(url, { method: 'POST', signal: AbortSignal.timeout(10_000), headers: { Authorization: `${bearer} ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json()

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

/** The watchdog's tick: DM the operator about `reason` unless they have been told, or the retries are used up. A failed send is logged and tried again next tick. */
export async function alertOperatorOnce(
  stateDir: string, platform: string, reason: string, text: string,
  log: (line: string) => void, send: typeof alertOperator = alertOperator,
): Promise<void> {
  if (!shouldAlertOperator(stateDir, reason)) return
  if (!startOperatorAlert(stateDir, reason)) return log(`could not tell the operator: ${stateDir} is not writable, so the DM would repeat every tick`)
  const failed = await send(stateDir, platform, text)
  if (failed) log(`could not tell the operator: ${failed}`)
  else finishOperatorAlert(stateDir)
}
