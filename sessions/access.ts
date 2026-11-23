import { STATE_DIR, gateway, DEFAULT_SESSION_CHANNEL, PLATFORM } from '../infra/config.js'
import { currentHydraConfig, hydraLoadEnv, reloadHydraConfig } from '../infra/hydra-config.js'
import { admitChannel } from '../config/admit.js'
import { BUSY } from '../config/append.js'
import { chunk, safeSend } from '../infra/util.js'
import { hearsApp } from '../config/hears.js'
import type { GateSettings } from '../config/types.js'
import type { InboundMessage } from '../gateways/gateway.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Who this daemon hears in one channel, as the gate reads it. */
export type GroupPolicy = {
  requireMention: boolean
  /** Empty: anyone who tags. */
  allowFrom: string[]
  threadReply?: boolean
  defaultListen?: boolean
}

export type GateResult = { action: 'deliver' } | { action: 'drop' }

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export function maxChunkLimit(): number { return gateway.maxMessageLength }

/**
 * The operator's user ids on this platform: every admin check and admin DM reads this. hydra.toml's operator, by their
 * addresses here. A hydra.toml that hasn't loaded gives nobody.
 */
export function operatorIds(): string[] {
  const cfg = currentHydraConfig()
  if (!cfg.operator) return []
  const prefix = `${PLATFORM}:`
  return cfg.people[cfg.operator].addresses.filter(a => a.startsWith(prefix)).map(a => a.slice(prefix.length))
}

/** hydra.toml's gate settings for this platform (`[gateways.<platform>]`): the one reader of them. */
function gateSettings(): GateSettings | undefined {
  return currentHydraConfig().gateSettings?.[PLATFORM]
}

/**
 * The policy hydra.toml gives a channel (`[places."<platform>:<id>".access]`), or undefined. Exact key: no wildcard
 * entry admits a channel. `allow` becomes ids on this platform (the loader makes sure each person has one; an empty allowFrom means anyone).
 */
function policyOf(channelId: string): GroupPolicy | undefined {
  const cfg = currentHydraConfig()
  const place = cfg.channels?.[`${PLATFORM}:${channelId}`]
  if (!place) return undefined
  const prefix = `${PLATFORM}:`
  const ids = place.access.allow === 'anyone' ? [] : place.access.allow.flatMap(n => cfg.people[n].addresses.filter(a => a.startsWith(prefix)).map(a => a.slice(prefix.length)))
  return {
    requireMention: place.access.mention,
    allowFrom: ids,
    ...(place.threadReply !== undefined && { threadReply: place.threadReply }),
    ...(place.access.listen !== undefined && { defaultListen: place.access.listen }),
  }
}

/** Whether a session thread started in this channel listens untagged; undefined when hydra.toml says nothing. */
export function channelListen(channelId: string): boolean | undefined {
  return policyOf(channelId)?.defaultListen
}

/** The platform-wide listen default. */
export function defaultListenOf(): boolean {
  return gateSettings()?.listen ?? false
}

export function ackReactionOf(): string | undefined {
  return gateSettings()?.ackReaction
}

// Resolves true only if the whole message reached someone.
export async function notifyOperator(text: string): Promise<boolean> {
  const parts = chunk(text, gateway.maxMessageLength, 'markdown')
  const operator = operatorIds()
  if (operator.length > 0) {
    const delivered = await Promise.all(operator.map(async userId => {
      try {
        for (const part of parts) await gateway.sendDM(userId, part)
        return true
      } catch (e) {
        process.stderr.write(`daemon: operator notify DM failed: ${e}\n`)
        return false
      }
    }))
    return delivered.includes(true)
  }
  if (DEFAULT_SESSION_CHANNEL) {
    for (const part of parts) {
      const sent = await safeSend(DEFAULT_SESSION_CHANNEL, part)
      if (sent.length === 0) return false
    }
    return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

/** Where an event happened: enough to ask whether this daemon is allowed there. */
export type Place = Pick<InboundMessage, 'isDM' | 'channelId' | 'parentChannelId'>

/**
 * The group policy of the channel a place is in (a thread's parent channel; parentChannelId is null outside
 * a thread); undefined when this daemon has none there.
 */
export function channelPolicy(place: Place): GroupPolicy | undefined {
  return policyOf(place.parentChannelId ?? place.channelId)
}

/**
 * Whether this daemon acts in the place at all, whoever the sender is: a DM, or a channel it has a
 * policy for. Two daemons can share a guild and an operator; an operator's word in the other
 * daemon's channel is not this daemon's to obey.
 */
export function channelAllowed(place: Place): boolean {
  return place.isDM || channelPolicy(place) !== undefined
}

/** Channels where an admit was refused and the operator told, so each hears it once. */
const refusedAdmits = new Set<string>()

/**
 * The operator tagging this bot in a channel it has no policy for admits that channel: mention-only at the top level, session threads started there listen untagged.
 * It is written into hydra.toml and the same message goes on; a write hydra.toml refuses is said to the operator once per channel and admits nothing.
 * True when it admitted. Anyone else's tag admits nothing.
 */
export async function admitTaggedChannel(msg: InboundMessage): Promise<boolean> {
  if (msg.isDM || !operatorIds().includes(msg.authorId)) return false
  // Only an explicit @-tag admits: a reply to the bot or a mentionPatterns match does not.
  if (!(await gateway.isMentioned({ ...msg, referenceMessageId: null }))) return false
  // A tag that arrived just before this one may have admitted the channel while we awaited.
  if (channelAllowed(msg)) return true
  const channelId = msg.parentChannelId ?? msg.channelId
  // operatorIds named the sender, so hydra.toml names an operator.
  const admitted = admitChannel(STATE_DIR, hydraLoadEnv(), PLATFORM, channelId, currentHydraConfig().operator!)
  if (!admitted.ok) {
    // A busy lock passes in a moment: it does not use up the channel's one telling.
    if (admitted.error !== BUSY && !refusedAdmits.has(channelId)) {
      refusedAdmits.add(channelId)
      void safeSend(msg.channelId, `I can't add this channel to hydra.toml, so I did nothing here: ${admitted.error}\nFix that, then tag me again.`, { replyTo: msg.id })
    }
    return false
  }
  refusedAdmits.delete(channelId)
  reloadHydraConfig()
  return true
}

/** Whether `msg` tags the bot or matches this platform's configured mention patterns. */
export function mentionsUs(msg: InboundMessage): Promise<boolean> {
  return gateway.isMentioned(msg, gateSettings()?.mentionPatterns)
}

/**
 * Whether another app's message is heard at all: hydra.toml declares it as a person (`hearsApp`), and it is not this daemon's own bot. Heard, it goes
 * through the gate as that person: `allow` and the mention rule apply to it as to anyone.
 */
export function heardApp(msg: Pick<InboundMessage, 'authorId'>): boolean {
  const cfg = currentHydraConfig()
  return msg.authorId !== gateway.botId && hearsApp(cfg.people, cfg.operator, `${PLATFORM}:${msg.authorId}`)
}

/** Whether the router drops this app message: it is undeclared. Said on stderr when it tags us in a place we're in, since its sender would otherwise wait on silence. */
export async function droppedApp(msg: InboundMessage): Promise<boolean> {
  if (heardApp(msg)) return false
  if (channelAllowed(msg) && msg.authorId !== gateway.botId && await mentionsUs(msg)) process.stderr.write(`daemon: dropped a message that tags this bot, from another app (${gateway.platform}:${msg.authorId}) in ${msg.channelId}: hydra.toml's [people] does not declare it\n`)
  return true
}

export async function gate(msg: InboundMessage): Promise<GateResult> {
  if (gateSettings()?.off) return { action: 'drop' }

  const senderId = msg.authorId

  if (msg.isDM) return operatorIds().includes(senderId) ? { action: 'deliver' } : { action: 'drop' }

  const policy = channelPolicy(msg)
  if (!policy) return { action: 'drop' }
  if (policy.allowFrom.length > 0 && !policy.allowFrom.includes(senderId)) return { action: 'drop' }
  if (policy.requireMention && !(await mentionsUs(msg))) return { action: 'drop' }
  return { action: 'deliver' }
}
