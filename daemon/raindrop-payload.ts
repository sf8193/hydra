import { canonicalModel, type Sentiment } from '../shared/constants.js'

const RAINDROP_API_BASE = 'https://api.raindrop.ai/v1'
export const EVENT_ENDPOINT = `${RAINDROP_API_BASE}/events/track`
export const SIGNAL_ENDPOINT = `${RAINDROP_API_BASE}/signals/track`

type HydraEvent =
  | 'hydra.session.spawn'
  | 'hydra.session.reply'
  | 'hydra.session.death'
  | 'hydra.env.sweep_failed'

type PropertyValue = string | number

export type SessionFacts = {
  threadId: string
  createdAt: number
  tmuxName?: string
  engine?: string
  model?: string
  sessionType?: string
  originType?: string
  platform?: string
  project?: string
}

export const SESSION_PROPERTY_KEYS = [
  'tmuxName',
  'engine',
  'sessionType',
  'originType',
  'platform',
] as const satisfies readonly (keyof SessionFacts)[]

export type EventBody = {
  event_id: string
  event: HydraEvent
  user_id: string
  timestamp: string
  properties: Record<string, PropertyValue>
}

export type SignalBody = {
  event_id: string
  signal_name: string
  signal_type: 'default'
  sentiment: Sentiment
}

const REPO_NAME = /^[A-Za-z0-9._-]{1,40}$/
const THREAD_ID = /^[A-Za-z0-9_-]{1,32}(:\d{10}\.\d{6})?$/
const PROPERTY_VALUE = /^[A-Za-z0-9._:/-]{1,64}$/
// A charset bound is not a PII bound — an SSN satisfies all of them.
const SSN_SHAPE = /\d{3}-\d{2}-\d{4}/
// Only for the enum-shaped values: a Discord snowflake and an epoch-ms event
// id are both long digit runs, so ids cannot carry this rule.
const LONG_DIGITS = /\d{13,}/
const EVENT_ID = /^[A-Za-z0-9._:-]{1,64}$/
const USER_ID = /^[A-Za-z0-9._:|-]{1,64}$/

function safeExtra(extra: Record<string, string | number> | undefined): Record<string, PropertyValue> {
  const out: Record<string, PropertyValue> = {}
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (typeof v === 'number') { out[k] = v; continue }
    const safe = safeProperty(v)
    if (safe !== undefined) out[k] = safe
  }
  return out
}

function gate(pattern: RegExp, rejectLongDigits = false) {
  return (v: string | undefined): string | undefined => (
    v !== undefined && pattern.test(v) && !SSN_SHAPE.test(v)
      && !(rejectLongDigits && LONG_DIGITS.test(v)) ? v : undefined
  )
}

export const safeRepoName = gate(REPO_NAME, true)
const safeThreadId = gate(THREAD_ID)
const safeProperty = gate(PROPERTY_VALUE, true)
export const safeEventId = gate(EVENT_ID)
export const safeUserId = gate(USER_ID)

function sessionProperties(facts: SessionFacts, omitRepo: boolean): Record<string, PropertyValue> {
  const props: Record<string, PropertyValue> = {}
  for (const key of SESSION_PROPERTY_KEYS) {
    const value = facts[key]
    const safe = safeProperty(value)
    if (safe !== undefined) props[key] = safe
  }
  const repo = omitRepo ? undefined : safeRepoName(facts.project)
  if (repo) props.repo = repo
  return props
}

export type EventInput = {
  event: HydraEvent
  eventId: string
  userId: string
  facts: SessionFacts
  threadId: string
  at: number
  replyChars?: number
  omitRepo: boolean
  extra?: Record<string, string | number>
}

export function buildEvent(input: EventInput): EventBody | undefined {
  const { event, eventId, userId, facts, threadId, at, replyChars, omitRepo, extra } = input
  const id = safeEventId(eventId)
  const user = safeUserId(userId)
  if (!id || !user) return undefined
  const model = facts.model ? canonicalModel(facts.model) : undefined
  const thread = safeThreadId(threadId)
  return {
    event_id: id,
    event,
    user_id: user,
    timestamp: new Date(at).toISOString(),
    properties: {
      ...sessionProperties(facts, omitRepo),
      ...(thread ? { threadId: thread } : {}),
      ...(model ? { model } : {}),
      ...(replyChars === undefined ? {} : { replyChars }),
      ...safeExtra(extra),
    },
  }
}

export function buildSignal(eventId: string, name: string, sentiment: Sentiment): SignalBody {
  return { event_id: eventId, signal_name: name, signal_type: 'default', sentiment }
}


