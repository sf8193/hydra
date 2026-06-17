import { realpathSync } from 'fs'
import { join, sep } from 'path'
import { execSync } from 'child_process'
import { gateway, STATE_DIR } from './config.js'

export function fallbackDescription(topic: string): string {
  const firstLine = topic.split('\n')[0].replace(/^\/\S+\s*/, '').trim()
  return firstLine.length > 100 ? firstLine.slice(0, 97) + '...' : firstLine
}

export function formatDuration(ms: number): string {
  const mins = Math.floor(ms / 60000)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  const remMins = mins % 60
  if (hrs < 24) return remMins > 0 ? `${hrs}h ${remMins}m` : `${hrs}h`
  const days = Math.floor(hrs / 24)
  const remHrs = hrs % 24
  return remHrs > 0 ? `${days}d ${remHrs}h` : `${days}d`
}

export function getContextPercent(tmuxName: string): string {
  try {
    const pane = execSync(`tmux capture-pane -t '${tmuxName}' -p 2>/dev/null`, { stdio: ['pipe', 'pipe', 'pipe'], timeout: 2000 }).toString()
    const match = pane.match(/(\d+)%\n/)
    return match ? `${match[1]}%` : '?'
  } catch { return '?' }
}

export function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

export function assertSendable(f: string): void {
  let real, stateReal: string
  try {
    real = realpathSync(f)
    stateReal = realpathSync(STATE_DIR)
  } catch { return }
  const inbox = join(stateReal, 'inbox')
  if (real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep)) {
    throw new Error(`refusing to send channel state: ${f}`)
  }
}

export async function reportError(
  channelId: string, messageId: string,
  command: string, reason: string, suggestion?: string,
): Promise<void> {
  void gateway.react(channelId, messageId, '❌').catch(() => {})
  const lines = [`:x: \`${command}\` failed: ${reason}`]
  if (suggestion) lines.push(suggestion)
  try { await gateway.send(channelId, lines.join('\n'), { replyTo: messageId }) } catch {}
}
