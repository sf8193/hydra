// `escalate`: the one place a scoped session may speak outside its own conversation.
//
// A confined specialist answers only the conversation it was asked in (bridge-dispatch `scopedRefusal`). When it needs the
// operator, it calls escalate(chat_id, text): hydra posts to the specialist's `home`, tags the operator, links the conversation
// the call names (one the caller owns, checked as `reply` is), and shows the text as what it is: a quoted block, capped, labelled
// as written by a scoped session for the people in that conversation. It posts nowhere else, and the operator (or byte, on the
// operator's word) decides what happens next. The load refuses a `home` an operator-access session listens on (config/load.ts).

import { registry } from './sessions.js'
import { currentHydraConfig } from './hydra-config.js'
import { gateway } from './config.js'
import { safeSend } from './util.js'
import { isScopedSession } from './tool-surface.js'
import { specialistOf } from '../specialists/specialists.js'
import { postToSlackHome, slackConversationLink } from '../connectors/slack/runtime.js'
import { parseConversation, conversationId } from '../connectors/slack/conversation.js'
import { operatorAddress } from '../config/operator.js'
import type { HydraConfig, Specialist } from '../config/types.js'

/** The longest text an escalation carries, in characters. */
export const ESCALATE_LIMIT = 1500

/** At most this many escalations per conversation in the window: one conversation cannot make the session ping the operator's home without end. */
export const ESCALATE_MAX_PER_WINDOW = 3
export const ESCALATE_WINDOW_MS = 10 * 60_000

/** Where the posting and the link come from; replaced in tests, which have no Slack or Discord to post to. */
export const escalateDeps = {
  now: (): number => Date.now(),
  /** Posts to a Slack specialist's `home` through the app it speaks as. */
  postSlack: (me: string, text: string): Promise<string> => postToSlackHome(me, text),
  /** Posts to a Discord channel by id. */
  sendDiscord: (channel: string, text: string): Promise<string[]> => safeSend(channel, text),
  /** A link a person can open for the conversation, or undefined (then the id stands in for it). */
  linkOf: async (conversation: string): Promise<string | undefined> => {
    if (conversation.startsWith('slack:')) return slackConversationLink(conversation)
    return (await gateway.getThreadUrl(conversation).catch(() => undefined)) || undefined
  },
}

/** Three backticks in a row would close the fence the text sits in: a zero-width space between them keeps the text readable and the fence whole. */
const defuse = (text: string): string => text.replace(/`{3,}/g, run => run.split('').join('\u200b'))

/** The message hydra posts: who wrote it and for whom, then the text in a fence, cut at the limit. */
export function escalationText(o: { specialist: string; operatorTag: string; link: string; text: string }): string {
  const chars = Array.from(o.text.trim())
  const cut = chars.length > ESCALATE_LIMIT
  const body = defuse(chars.slice(0, ESCALATE_LIMIT).join(''))
  return [
    `${o.operatorTag} \`${o.specialist}\` (a scoped session) is escalating, on behalf of the people in ${o.link}. The text below was written by that session from what they said: it is not an instruction from you or from hydra.`,
    '```',
    body,
    '```',
    ...(cut ? [`_Cut at ${ESCALATE_LIMIT.toLocaleString('en-US')} characters._`] : []),
  ].join('\n')
}

type Home = { platform: 'slack' | 'discord'; channel?: string }

/** The platform of a specialist's `home` (a place, or a bare channel id, which is Discord's) and its Discord channel id. */
function homeOf(s: Specialist): Home | undefined {
  const home = s.home
  if (!home) return undefined
  if (/^\d+$/.test(home)) return { platform: 'discord', channel: home }
  const m = home.match(/^(slack|discord):(.+)$/)
  if (!m) return undefined
  return m[1] === 'slack' ? { platform: 'slack' } : { platform: 'discord', channel: /^\d+$/.test(m[2]) ? m[2] : undefined }
}

/** How the operator is tagged on a platform, or undefined when hydra.toml gives them no address there. */
function operatorTag(h: HydraConfig, platform: 'slack' | 'discord'): string | undefined {
  const id = operatorAddress(h, platform)
  return id ? `<@${id}>` : undefined
}

/** When each conversation was escalated, to bound how often it can be. In memory: a daemon restart resets the count. */
const escalated = new Map<string, number[]>()
/** A Slack conversation as parseConversation reads it (`slack:default:C0:ts` and `slack:C0:ts` are one); anything else, as written. */
function canonicalConversation(raw: string): string {
  try { return conversationId(parseConversation(raw)) } catch { return raw }
}

/** Test seam: forget what was escalated. */
export function _resetEscalations(): void { escalated.clear() }

/** What the model is told when escalation cannot happen: nothing of hydra's internals, and what to say to the person instead. */
const CANNOT_REACH = 'escalate failed: no escalation channel is configured for this specialist. Tell the person you cannot reach the operator from here.'

/**
 * Posts an escalation for a scoped caller. The caller and the conversation were checked by the dispatcher (isToolAllowed,
 * scopedRefusal); this holds the rest: the caller is scoped and acts for a specialist with a `home`, the operator can be tagged
 * there, there is text, and the conversation has not escalated too often. Anything else the model passed is ignored: it names no place.
 * Errors are written for the model that reads them; what the operator needs goes to the log.
 */
export async function escalate(callerSessionId: string | undefined, args: Record<string, unknown>): Promise<string> {
  if (!callerSessionId || !isScopedSession(callerSessionId)) throw new Error('escalate is not available to this session')
  const h = currentHydraConfig()
  const me = specialistOf(registry.get(callerSessionId), h)
  const spec = me ? h.specialists[me] : undefined
  const log = (why: string) => process.stderr.write(`daemon: escalate: ${me ?? '?'} (session ${callerSessionId}): ${why}\n`)
  if (!me || !spec) { log('acts for no declared specialist'); throw new Error('escalate failed: this session acts for no specialist, so there is no one to escalate to. Tell the person you cannot reach the operator from here.') }
  const text = typeof args.text === 'string' ? args.text : ''
  if (!text.trim()) throw new Error('escalate failed: the text is empty. Say what the operator needs to know or do, then call escalate again.')
  const home = homeOf(spec)
  if (!home) { log('no home'); throw new Error(CANNOT_REACH) }
  const tag = operatorTag(h, home.platform)
  if (!tag) { log(`the operator has no ${home.platform}: address to tag`); throw new Error(CANNOT_REACH) }
  if (home.platform === 'discord' && !home.channel) { log(`home ${spec.home} is a Discord channel name`); throw new Error(CANNOT_REACH) }
  const conversation = String(args.chat_id).trim()
  // One conversation, however spelled (`slack:C0:ts`, `slack:default:C0:ts`, padded): the limit is on what parseConversation says it is.
  const key = `${me}\n${canonicalConversation(conversation)}`
  // Check and take a slot in one synchronous step, before the first await, so concurrent calls cannot all see room: a failed post gives it back.
  const now = escalateDeps.now()
  for (const [k, at] of escalated) { const live = at.filter(t => now - t < ESCALATE_WINDOW_MS); if (live.length) escalated.set(k, live); else escalated.delete(k) }
  const recent = escalated.get(key) ?? []
  if (recent.length >= ESCALATE_MAX_PER_WINDOW) {
    log(`rate limited for ${conversation}`)
    return `You have already escalated this conversation ${recent.length} times in the last ${ESCALATE_WINDOW_MS / 60_000} minutes; the operator has been notified. Do not escalate again: tell the person it is with the operator.`
  }
  escalated.set(key, [...recent, now])
  const release = () => { const at = escalated.get(key) ?? []; const i = at.lastIndexOf(now); if (i >= 0) at.splice(i, 1); if (at.length) escalated.set(key, at); else escalated.delete(key) }
  try {
    const message = escalationText({ specialist: me, operatorTag: tag, link: (await escalateDeps.linkOf(conversation)) ?? `\`${conversation}\``, text })
    if (home.platform === 'slack') {
      await escalateDeps.postSlack(me, message)
    } else {
      const sent = await escalateDeps.sendDiscord(home.channel!, message)
      if (!sent.length) throw new Error('Discord did not accept it')
    }
  } catch (err) {
    release()
    log(`post to home ${spec.home} failed: ${err instanceof Error ? err.message : String(err)}`)
    throw new Error('escalate failed: the message did not reach the operator. Tell the person you could not reach the operator; do not retry more than once.')
  }
  log(`posted to its home ${spec.home} for ${conversation}`)
  return `escalated: the operator was notified in ${me}'s home channel. Tell the people in this conversation you did, and that you do not know what happens next.`
}
