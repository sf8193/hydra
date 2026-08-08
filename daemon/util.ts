import { realpathSync, writeFileSync, renameSync } from 'fs'
import { join, sep } from 'path'
import { execSync, execFileSync } from 'child_process'
import { gateway, STATE_DIR } from './config.js'
import { formatDiscordTables } from '../discord-table-format.js'

export function atomicWriteFileSync(filePath: string, data: string, mode?: number): void {
  const tmp = filePath + '.tmp'
  writeFileSync(tmp, data, { mode: mode ?? 0o600 })
  renameSync(tmp, filePath)
}

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

export function isAlive(info: { tmuxName: string; deadAt?: number }): boolean {
  if (info.deadAt) return false
  return tmuxHasSession(info.tmuxName)
}

export function tmuxHasSession(name: string): boolean {
  try {
    execFileSync('tmux', ['has-session', '-t', name], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

export function getContextPercent(tmuxName: string): string {
  try {
    const pane = execFileSync('tmux', ['capture-pane', '-t', tmuxName, '-p'], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 2000 }).toString()
    // Match from the last few lines only (Claude's status bar) to avoid matching percentages in conversation text
    const lines = pane.trimEnd().split('\n')
    const tail = lines.slice(-3).join('\n')
    const match = tail.match(/(\d+)%/)
    return match ? `${match[1]}%` : '?'
  } catch { return '?' }
}

// Strip protocol routing tags from displayed text. The machine tag
// ([critic→owner]) is consumed by dispatchReply for routing; the human
// sees only the content. [summary] stripping is handled unconditionally
// in bridge-dispatch.ts (survives cancel/timeout). Free-form posts and
// non-routing sentinels ([done]) pass through unchanged.
const ROLE_TAG_RE = /^\[([a-z][\w-]*)→[\w-]+\]\s*/i

const titleCaseRole = (role: string): string =>
  role.split('-').map(w => (w ? w[0].toUpperCase() + w.slice(1) : w)).join('-')

export function transformProtocolTag(
  text: string,
): string {
  const nl = text.indexOf('\n')
  const firstLine = (nl === -1 ? text : text.slice(0, nl)).trim()

  const m = firstLine.match(ROLE_TAG_RE)
  if (!m) return text
  const rest = nl === -1 ? '' : text.slice(nl)
  const remainder = firstLine.replace(ROLE_TAG_RE, '')
  const stripped = remainder ? `${remainder}${rest}` : rest
  const result = stripped.replace(/^\n+/, '')
  return result || text
}

// Bounded to 24h: a zero duration is meaningless for any timer this feeds,
// and values past 2^31-1 ms overflow setTimeout (fires immediately). Out of
// range → null, same visible-failure contract as unparseable input.
export const MAX_DURATION_MS = 24 * 3_600_000

export function parseDuration(s: string): number | null {
  const m = s.trim().match(/^(\d+)(s|m|h)$/i)
  if (!m) return null
  const n = parseInt(m[1], 10)
  const unit = m[2].toLowerCase()
  const ms = n * (unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3_600_000)
  if (ms <= 0 || ms > MAX_DURATION_MS) return null
  return ms
}

// Strips a spawn-level `--phase-budget <dur>` flag from a topic string.
// An unparseable duration is left in the topic on purpose — it surfaces in
// the thread name instead of being silently dropped.
export function extractPhaseBudget(topic: string): { topic: string; budgetMs?: number } {
  const m = topic.match(/(^|\s)--phase-budget[= ](\d+[smh])(?=\s|$)/i)
  if (!m) return { topic }
  const budgetMs = parseDuration(m[2])
  if (budgetMs == null) return { topic }
  return { topic: topic.replace(m[0], m[1] ? ' ' : '').replace(/\s+/g, ' ').trim(), budgetMs }
}

// One spawn, one line, one grammar — emitted from doSpawnSession itself so no
// spawn path (chat, template, protocol role, CLI, bridge tool, fork, respawn)
// can forget to announce. Scaffolding is blockquoted; performance is not.
export function formatSpawnLine(p: {
  roleLabel?: string
  emoji: string
  name: string
  model: string
  trigger: string
  initiator?: string
}): string {
  const title = p.roleLabel ? `The ${titleCaseRole(p.roleLabel)} • ` : ''
  const by = p.initiator ? `${p.trigger} from ${p.initiator}` : p.trigger
  return `> ⚡ spawned [ ${title}${p.emoji} ${p.name} ] · model \`${p.model}\` · by ${by}`
}

export type StatusLineState = {
  messageIds: string[]
  statusHistory?: string[]
}

export function chunk(text: string, limit: number, mode: 'length' | 'newline' | 'markdown'): string[] {
  if (text.length <= limit) return [text]

  if (mode !== 'markdown') {
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

  return chunkMarkdown(text, limit)
}

function fenceState(text: string): { open: boolean; lang: string } {
  let open = false
  let lang = ''
  for (const m of text.matchAll(/^(`{3,})(.*)?$/gm)) {
    if (!open) {
      open = true
      lang = (m[2] ?? '').trim()
    } else {
      open = false
      lang = ''
    }
  }
  return { open, lang }
}

function chunkMarkdown(text: string, limit: number): string[] {
  const FENCE_CLOSER = '\n```'
  const safeLimit = Math.max(limit, FENCE_CLOSER.length + 1)
  const out: string[] = []
  let rest = text

  while (rest.length > safeLimit) {
    const cut = pickMarkdownCut(rest, safeLimit - FENCE_CLOSER.length)
    let part = rest.slice(0, cut)
    let nextRest = rest.slice(cut).replace(/^\n+/, '')

    const { open, lang } = fenceState(part)
    if (open) {
      const opener = lang ? '```' + lang : '```'
      const candidateRest = opener + '\n' + nextRest
      if (candidateRest.length < rest.length) {
        part = part.replace(/\n?$/, FENCE_CLOSER)
        nextRest = candidateRest
      }
    }

    out.push(part)
    rest = nextRest
  }

  if (rest) out.push(rest)
  return out
}

function pickMarkdownCut(text: string, limit: number): number {
  const window = text.slice(0, limit)
  const lines = window.split('\n')

  let bestParaOutside = -1
  let bestLineOutside = -1
  let bestInsideFence = -1
  let pos = 0
  let fenceOpen = false
  let inTable = false

  for (let i = 0; i < lines.length; i++) {
    const lineEnd = pos + lines[i].length
    if (lineEnd > limit) break
    const cutAfter = lineEnd + 1

    if (/^`{3,}/.test(lines[i])) fenceOpen = !fenceOpen

    const isTableRow = /^\s*\|/.test(lines[i])
    if (!isTableRow) inTable = false
    else if (!inTable) inTable = true

    if (!fenceOpen) {
      if (lines[i] === '' && i > 0 && cutAfter <= limit) {
        bestParaOutside = cutAfter
      } else if (!inTable && cutAfter <= limit) {
        bestLineOutside = cutAfter
      }
    } else {
      if (cutAfter <= limit) bestInsideFence = cutAfter
    }

    pos = lineEnd + 1
  }

  if (bestParaOutside > limit / 4) return bestParaOutside
  if (bestLineOutside > limit / 4) return bestLineOutside
  if (bestInsideFence > limit / 4) return bestInsideFence

  const space = text.lastIndexOf(' ', limit)
  if (space > 0) return space
  return limit
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

export async function safeSend(
  channelId: string, text: string, opts?: { replyTo?: string },
): Promise<string[]> {
  const formatted = gateway.platform === 'discord' ? formatDiscordTables(text) : text
  const chunks = chunk(formatted, gateway.maxMessageLength, 'markdown')
  const sentIds: string[] = []
  for (let i = 0; i < chunks.length; i++) {
    try {
      const sent = await gateway.send(channelId, chunks[i], {
        ...(i === 0 && opts?.replyTo ? { replyTo: opts.replyTo } : {}),
      })
      sentIds.push(sent.id)
    } catch (err) {
      process.stderr.write(`daemon: safeSend failed on chunk ${i + 1}/${chunks.length}: ${String(err)}\n`)
      if (sentIds.length > 0 && i < chunks.length - 1) {
        try { await gateway.send(channelId, '_[message truncated]_') } catch {}
      }
      break
    }
  }
  return sentIds
}
