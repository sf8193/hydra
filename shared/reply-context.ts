// What a reply points at. When the operator answers with the platform's Reply, the session
// is told which earlier message the answer refers to: who wrote it and a short quote.
// One home for the meta keys, the trimming and the one-line wording, so every way a message
// reaches a session (channel, typed paste, held and flushed, codex turn) says it the same way.
import type { ChatGateway, InboundMessage, ReplyContext } from '../gateways/gateway.js'
import { oneLine } from './untrusted-text.js'

/** Characters of the quoted message kept: enough to recognise it, short enough not to bury the answer. */
export const REPLY_QUOTE_MAX = 300
/** The lookup runs inside the session's ingress slot; past this the id alone is delivered. */
export const REPLY_LOOKUP_TIMEOUT_MS = 2000

/** One clean line (controls, direction marks and invisible code points gone), cut by character so no emoji is split. */
export function trimQuote(text: string, max: number = REPLY_QUOTE_MAX): string {
  const chars = Array.from(oneLine(text, Infinity))
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : chars.join('')
}

/**
 * The meta keys a delivery carries for a reply; empty when the message is not a reply. The sender's words are cleaned
 * here, once, so no consumer receives a control or direction character. `in_reply_to_by_us` marks a message hydra
 * itself sent: the only one whose text a user-authored turn may quote (see replyContextLine).
 */
export function replyContextMeta(ctx: ReplyContext | null): Record<string, string> {
  if (!ctx) return {}
  const user = ctx.author ? trimQuote(ctx.author, 80) : ''
  const text = ctx.content ? trimQuote(ctx.content) : ''
  return {
    in_reply_to_id: ctx.id,
    ...(user ? { in_reply_to_user: user } : {}),
    ...(text ? { in_reply_to_content: text } : {}),
    ...(ctx.byUs ? { in_reply_to_by_us: 'true' } : {}),
  }
}

/** A value on the line: one line, and none of the characters the frame is made of, so it cannot spell out a field or close the bracket. */
const unframe = (s: string): string => s.replace(/["[\]]/g, '').replace(/\s+/g, ' ').trim()

/**
 * The reply, in one line, for a turn typed or steered in as the operator's own: `in reply to <user> (msg <id>): "<quote>"`;
 * '' when meta carries none. Another person's words do not ride inside the operator's turn: author and quote appear only
 * for a message hydra sent; otherwise the id alone names it and the session can read it with fetch_messages.
 */
export function replyContextLine(meta: Record<string, string>): string {
  const id = meta.in_reply_to_id
  if (!id) return ''
  const ours = meta.in_reply_to_by_us === 'true'
  const who = ours && meta.in_reply_to_user ? `${unframe(meta.in_reply_to_user)} ` : ''
  const quote = ours && meta.in_reply_to_content ? `: "${unframe(meta.in_reply_to_content)}"` : ''
  return `in reply to ${who}(msg ${unframe(id)})${quote}`
}

/**
 * What `msg` replies to, or null. A platform answers through `getReplyContext`; one without it
 * (Slack: its reference is the thread root, not a reply) reports nothing. A lookup that fails or
 * is slow still delivers the id, so the session knows an earlier message was meant.
 */
export async function resolveReplyContext(
  gateway: Pick<ChatGateway, 'getReplyContext'>,
  msg: InboundMessage,
  timeoutMs: number = REPLY_LOOKUP_TIMEOUT_MS,
): Promise<ReplyContext | null> {
  if (!msg.referenceMessageId || !gateway.getReplyContext) return null
  const idOnly: ReplyContext = { id: msg.referenceMessageId, author: null, content: null, byUs: false }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const found = await Promise.race([
      gateway.getReplyContext(msg),
      new Promise<'timeout'>(r => { timer = setTimeout(() => r('timeout'), timeoutMs) }),
    ])
    return found === 'timeout' ? idOnly : found
  } catch {
    return idOnly
  } finally {
    clearTimeout(timer)
  }
}
