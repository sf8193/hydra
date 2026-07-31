// Liveness: a protocol participant that posts substantial content via reply()
// instead of advance() gets immediate feedback rather than waiting for the
// T-2m timeout warning. Replaces sentinel-nudge.ts — same pattern, different
// signal: tool choice instead of first-line tag.
import { transport } from './bridge-transport.js'
import { registry } from './sessions.js'
import { isProtocolPost, getAdvanceHint } from './protocol-registry.js'

const SUBSTANTIAL_LENGTH = 200
const NUDGE_COOLDOWN_MS = 60_000
const lastNudgeAt = new Map<string, number>()

export function maybeNudgeMissingAdvance(
  sessionId: string,
  text: string,
  chatId: string,
  now: number = Date.now(),
): boolean {
  if (text.length < SUBSTANTIAL_LENGTH) return false
  if (!isProtocolPost(sessionId, chatId)) return false

  const cooldownKey = `${sessionId}:${chatId}`
  const last = lastNudgeAt.get(cooldownKey) ?? 0
  if (now - last < NUDGE_COOLDOWN_MS) return false
  lastNudgeAt.set(cooldownKey, now)

  const hint = getAdvanceHint(sessionId, chatId)
  const hintLine = hint
    ? `If that was your deliverable, repost using \`${hint}\`.`
    : `If that was your deliverable, repost using \`advance({ content: "..." })\`.`

  const name = registry.get(sessionId)?.tmuxName ?? sessionId
  process.stderr.write(`daemon: liveness: ${name} posted ${text.length} chars via reply() without advance(), nudging\n`)
  transport.sendOrQueue(sessionId, {
    type: 'notification',
    content: [
      `[system] Your last post was sent via \`reply()\` — the protocol did NOT advance.`,
      hintLine,
      `\`reply()\` is conversational only; \`advance()\` posts to the thread AND advances the protocol.`,
    ].join('\n'),
    meta: { chat_id: chatId, message_id: '', user: 'system', user_id: 'system', ts: new Date(now).toISOString() },
  })

  for (const [key, at] of lastNudgeAt) {
    if (now - at >= NUDGE_COOLDOWN_MS) lastNudgeAt.delete(key)
  }
  return true
}

export function _resetNudgesForTesting(): void {
  lastNudgeAt.clear()
}
