// @ts-nocheck
// FROZEN COPY of the ownership rule in connectors/slack/runtime.ts as it was at the parent of the change that lets a plain session speak in a
// thread bound to its own thread (lines 377 and 460-511 there, verbatim but for `export` and the imports). bound-speak-fuzz.test.ts runs it
// beside the current rule on generated cases. Do not edit it to follow runtime.ts.
import { parseConversation } from '../../conversation.js'
import { appOfEntry, conversationId, isDm, TOP_LEVEL, type ConversationEntry } from '../../watch.js'
import { getConversationTable } from '../../runtime.js'
import { conversationSpecialistOf, boundAs } from '../../../../specialists/specialists.js'
import { conversationSessionName } from '../../../../specialists/targets.js'
import { registry, type SessionInfo } from '../../../../daemon/sessions.js'
import { MAIN, currentId, isSessionThread } from '../../../../routing/route.js'
import { currentHydraConfig as hydraConfig } from '../../../../daemon/hydra-config.js'
import type { HydraConfig } from '../../../../config/types.js'

const isConversationSession = (caller: Partial<Pick<SessionInfo, 'tmuxName'>> | undefined): boolean => !!conversationSpecialistOf(caller?.tmuxName)

/**
 * Whether the caller answers this conversation: a per-conversation session answers its own conversation and no other; a
 * shared session, any conversation bound to its specialist. `bound` is who the conversation is bound to (current id), `me` who the caller acts for.
 */
function mayAnswerConversation(h: HydraConfig, caller: SessionInfo | undefined, me: string | undefined, bound: string | undefined, id: string): boolean {
  const ownSession = !!caller && !!bound && [bound, ...(h.specialists[bound]?.renamedFrom ?? [])].some(sid => caller.tmuxName === conversationSessionName(sid, id))
  return isConversationSession(caller) ? ownSession : (!!me && bound === me)
}

/** What a session does in a conversation it must answer: the one rule below holds each, and names it in a refusal. */
export type OwnUse = 'a reply' | 'a read' | 'an edit' | 'a delete' | 'a reaction' | 'a download'
const OWN_VERB: Readonly<Record<OwnUse, string>> = { 'a reply': 'answer', 'a read': 'read', 'an edit': 'edit', 'a delete': 'delete', 'a reaction': 'react to', 'a download': 'download' }

/**
 * Why `conversation` is not one the caller may use as `use` (assertOwnConversation), or undefined when it is. Never throws: an id that parses
 * to nothing, or is not open, is not theirs. The dispatcher holds a restricted or write-confined session's every tool to this.
 */
export function ownConversationRefusal(callerSessionId: string | undefined, conversation: unknown, use: OwnUse = 'a reply'): string | undefined {
  try { assertOwnConversation(hydraConfig(), callerSessionId, conversation, use); return undefined } catch (err) { return err instanceof Error ? err.message : String(err) }
}

/**
 * Throws unless `conversation` is an open conversation the caller answers, and returns it: bound to the caller's specialist (a conversation's own
 * session: that conversation only), never one a session bound to itself to listen. The one ownership rule: `reply` holds every session to it, and
 * the dispatcher holds a restricted or write-confined session's every tool to it (`ownConversationRefusal`), `fetch_messages`, `edit_message`
 * and `delete_message` among them. It never counts the specialist's `home_place` (`reply` posts there on its own path).
 *
 * A read never reaches a channel's top level. Its conversation (`messages = "all"`) is only the untagged top-level messages, but Slack's
 * `history` returns every one, those routing gave to another specialist or app too. A DM's top level is the DM's alone, and stays readable.
 */
function assertOwnConversation(h: HydraConfig, callerSessionId: string | undefined, conversation: unknown, use: OwnUse): { c: ReturnType<typeof parseConversation>; app: string; id: string; entry: ConversationEntry; bound: string | undefined; caller: SessionInfo | undefined; me: string | undefined } {
  const c = parseConversation(conversation)
  const app = appOfEntry(c)
  const id = conversationId(c)
  if (use === 'a read' && c.threadTs === TOP_LEVEL && !isDm(c.channel)) {
    throw new Error(`${id} is a channel's top level, which holds every top-level message there, others' too: a read goes only to a thread bound to your specialist (${conversationId({ ...c, threadTs: '<thread ts>' })}) or a DM`)
  }
  const entry = getConversationTable().get(c.channel, c.threadTs, app)
  if (!entry) throw new Error(`${id} is not an open conversation, so there is nothing there to ${OWN_VERB[use]}`)
  const caller = callerSessionId ? registry.get(callerSessionId) : undefined
  const me = callerSessionId === 'main' ? MAIN : boundAs(caller, h)
  return { c, app, id, entry, bound: answeredBy(h, caller, me, entry, id, use), caller, me }
}

/** Throws unless the caller answers this open conversation (assertOwnConversation's rule, for an entry already in hand); returns who it is bound to. */
function answeredBy(h: HydraConfig, caller: SessionInfo | undefined, me: string | undefined, entry: ConversationEntry, entryId: string, use: OwnUse): string | undefined {
  const bound = entry.specialist ? currentId(h, entry.specialist) : undefined
  // A thread a session bound to itself is listen-only: only a specialist (or main) speaks in Slack.
  if (bound && isSessionThread(bound)) throw new Error(`${entryId} is bound to a session to listen to: hydra posts to Slack only for a specialist (or main), so reply to the operator instead`)
  if (!mayAnswerConversation(h, caller, me, bound, entryId)) throw new Error(`${entryId} is bound to ${bound ?? 'no one yet'}${me ? `, not ${me}` : ''}: ${use} goes only to a conversation bound to your specialist${isConversationSession(caller) ? ', and from a conversation\'s own session only to that conversation' : ''}`)
  return bound
}
