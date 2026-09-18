import { describe, test, expect } from 'bun:test'
import {
  buildEvent,
  buildSignal,
  EVENT_ENDPOINT,
  SIGNAL_ENDPOINT,
  type EventInput,
  safeRepoName,
  safeEventId,
  safeUserId,
  SESSION_PROPERTY_KEYS,
  type SessionFacts,
} from '../raindrop-payload.js'
import { sentimentForReaction, isDeleteReaction, SENTIMENT_REACTIONS, DELETE_REACTIONS } from '../../shared/constants.js'

const CREATED = 1789752921748

const facts: SessionFacts = {
  threadId: 'D0BE3RB4Y00:1789752921.353999',
  createdAt: CREATED,
  tmuxName: 'atlas',
  engine: 'claude',
  model: 'claude-opus-5[1m]',
  sessionType: 'thread_owner',
  originType: 'spawn',
  platform: 'slack',
  project: 'hydra',
}

const USER = 'U056CLXJY8P'

const evRaw = (over: Partial<EventInput> = {}) => buildEvent({
  event: 'hydra.session.spawn', eventId: 'e', userId: USER, facts, threadId: 't',
  at: CREATED, omitRepo: false, ...over,
})

const ev = (over: Partial<EventInput> = {}) => {
  const body = evRaw(over)
  if (!body) throw new Error('buildEvent refused this input; use evRaw to assert that')
  return body
}

describe('raindrop-payload: the wire contract', () => {
  test('the vendor endpoints are exactly these', () => {
    expect(EVENT_ENDPOINT).toBe('https://api.raindrop.ai/v1/events/track')
    expect(SIGNAL_ENDPOINT).toBe('https://api.raindrop.ai/v1/signals/track')
  })
})

describe('raindrop-payload: envelope', () => {
  test('builds the approved spawn envelope', () => {
    expect(ev({ eventId: 'sess-1', threadId: facts.threadId })).toEqual({
      event_id: 'sess-1',
      event: 'hydra.session.spawn',
      user_id: 'U056CLXJY8P',
      timestamp: '2026-09-18T17:35:21.748Z',
      properties: {
        tmuxName: 'atlas',
        engine: 'claude',
        sessionType: 'thread_owner',
        originType: 'spawn',
        platform: 'slack',
        repo: 'hydra',
        threadId: 'D0BE3RB4Y00:1789752921.353999',
        model: 'claude-opus-5[1m]',
      },
    })
  })

  test('threadId is the caller-supplied conversation, not the session thread', () => {
    const body = ev({ event: 'hydra.session.reply', eventId: 'msg-1', threadId: 'OTHER-CHAT' })
    expect(body.properties.threadId).toBe('OTHER-CHAT')
  })

  test('omits model rather than sending an empty one', () => {
    const body = ev({ facts: { ...facts, model: undefined } })
    expect('model' in body.properties).toBe(false)
  })

  test('sends no ai_data, so the vendor does not read it as an AI generation', () => {
    const body = ev() as Record<string, unknown>
    expect('ai_data' in body).toBe(false)
    expect('is_pending' in body).toBe(false)
  })

  test('drops undefined and empty-string properties', () => {
    const body = ev({ facts: { threadId: 't', createdAt: CREATED, engine: 'codex', tmuxName: '' } })
    expect(body.properties).toStrictEqual({ engine: 'codex', threadId: 't' })
  })
})

describe('raindrop-payload: egress allowlist', () => {
  test('a field absent from the allowlist never reaches the wire', () => {
    const leaky = {
      ...facts,
      topic: 'wire $2.4M to Acme Corp for SSN 123-45-6789',
      description: 'free text a session wrote',
      initiator: 'Kevin Liang',
      worktreeBranch: 'kevinliang/BANK-1234-acme',
      worktreePath: '/Users/kevin/RubymineProjects/.worktrees/hydra-atlas',
    } as SessionFacts
    const serialized = JSON.stringify(ev({ event: 'hydra.session.reply', facts: leaky }))
    expect(serialized).not.toContain('Acme')
    expect(serialized).not.toContain('123-45-6789')
    expect(serialized).not.toContain('free text')
    expect(serialized).not.toContain('Kevin Liang')
    expect(serialized).not.toContain('BANK-1234')
    expect(serialized).not.toContain('.worktrees')
  })

  test('no absolute path escapes — repo is a bare name', () => {
    const serialized = JSON.stringify(ev())
    expect(serialized).not.toContain('/Users/kevin')
    expect(JSON.parse(serialized).properties.repo).toBe('hydra')
  })

  test('replyChars is the only caller-supplied property with a free value', () => {
    const body = ev({ event: 'hydra.session.reply', replyChars: 10 })
    expect(body.properties).toStrictEqual({
      tmuxName: 'atlas', engine: 'claude', sessionType: 'thread_owner',
      originType: 'spawn', platform: 'slack', repo: 'hydra',
      threadId: 't', model: 'claude-opus-5[1m]', replyChars: 10,
    })
  })

  test('the envelope carries no message-text field', () => {
    const body = ev({ event: 'hydra.session.reply', replyChars: 1423 })
    expect(new Set(Object.keys(body))).toEqual(new Set([
      'event_id', 'event', 'user_id', 'timestamp', 'properties',
    ]))
  })

  test('the allowlist holds only non-freeform session metadata', () => {
    expect([...SESSION_PROPERTY_KEYS]).toEqual([
      'tmuxName', 'engine', 'sessionType', 'originType', 'platform',
    ])
  })
})

describe('raindrop-payload: the value gate is a PII gate, not just a charset gate', () => {
  const SSN = '123-45-6789'

  test.each(['tmuxName', 'engine', 'sessionType', 'originType', 'platform'] as const)(
    'an SSN in %s is dropped, not shipped', (key) => {
      const body = ev({ facts: { ...facts, [key]: SSN } })
      expect(JSON.stringify(body)).not.toContain(SSN)
      expect(key in body.properties).toBe(false)
    })

  test('a card-length digit run in an allowlisted value is dropped', () => {
    const body = ev({ facts: { ...facts, tmuxName: '4111111111111111' } })
    expect('tmuxName' in body.properties).toBe(false)
  })

  test('the whole event is refused rather than sent with a poisoned id', () => {
    expect(evRaw({ eventId: `msg-${SSN}` })).toBeUndefined()
    expect(evRaw({ userId: `U-${SSN}` })).toBeUndefined()
  })

  test('an SSN-shaped thread id is dropped, the rest of the event still ships', () => {
    const body = ev({ threadId: SSN })
    expect('threadId' in body.properties).toBe(false)
    expect(body.properties.engine).toBe('claude')
  })

  // Discord ids are long digit runs; the digit rule must not reach them.
  test.each(['846209781206941736', '1789760000000'])('a platform id %p survives as an id', (id) => {
    expect(safeEventId(id)).toBe(id)
    expect(safeUserId(id)).toBe(id)
  })
})

describe('raindrop-payload: safeRepoName', () => {
  test.each([
    undefined,
    '/Users/kevin/RubymineProjects/hydra',
    'SSN 123-45-6789',
    '123-45-6789',
    '4111111111111111',
    'wire $2.4M to acme',
    '{"ssn":"123-45-6789"}',
    'a'.repeat(41),
  ])('%p is dropped, not forwarded', (p) => {
    expect(safeRepoName(p)).toBeUndefined()
  })

  test('the residual: an identifier-shaped name up to 40 chars still ships', () => {
    expect(safeRepoName('eyJzc24iOiIxMjMtNDUtNjc4OSJ9')).toBe('eyJzc24iOiIxMjMtNDUtNjc4OSJ9')
    expect(safeRepoName('a'.repeat(40))).toBe('a'.repeat(40))
  })

  test.each(['hydra', 'nova', 'treasury', 'options_bot.v2', 'my-repo'])(
    'an ordinary project name %p survives', (n) => {
      expect(safeRepoName(n)).toBe(n)
    })
})

describe('raindrop-payload: signals', () => {
  test('builds a thumbs-down signal with no free text', () => {
    expect(buildSignal('msg-1', 'thumbs_down', 'NEGATIVE')).toEqual({
      event_id: 'msg-1',
      signal_name: 'thumbs_down',
      signal_type: 'default',
      sentiment: 'NEGATIVE',
    })
  })

  test.each<[string, string, 'POSITIVE' | 'NEGATIVE']>([
    ['+1', 'thumbs_up', 'POSITIVE'],
    ['thumbsup', 'thumbs_up', 'POSITIVE'],
    ['👍', 'thumbs_up', 'POSITIVE'],
    ['+1::skin-tone-3', 'thumbs_up', 'POSITIVE'],
    ['-1', 'thumbs_down', 'NEGATIVE'],
    ['thumbsdown', 'thumbs_down', 'NEGATIVE'],
    ['👎', 'thumbs_down', 'NEGATIVE'],
    ['👍🏽', 'thumbs_up', 'POSITIVE'],
    ['👎🏿', 'thumbs_down', 'NEGATIVE'],
    ['👍️', 'thumbs_up', 'POSITIVE'],
    ['-1::skin-tone-5', 'thumbs_down', 'NEGATIVE'],
  ])('reaction %s maps to %s', (emoji, name, sentiment) => {
    expect(sentimentForReaction(emoji)).toEqual({ name, sentiment })
  })

  test.each([
    'eyes', 'tada', 'hocho', '🔪', '🎉', '',
    'constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty',
  ])('reaction %p produces no signal', (emoji) => {
    expect(sentimentForReaction(emoji)).toBeUndefined()
  })
})

describe('reactions: sentiment and delete are disjoint vocabularies', () => {
  test('no reaction means both sentiment and delete', () => {
    const both = Object.keys(SENTIMENT_REACTIONS).filter(e => DELETE_REACTIONS.includes(e))
    expect(both).toEqual([])
  })

  test.each([...DELETE_REACTIONS])('the delete shortcut %p is not sentiment', (emoji) => {
    expect(sentimentForReaction(emoji)).toBeUndefined()
    expect(isDeleteReaction(emoji)).toBe(true)
  })

  test.each(Object.keys(SENTIMENT_REACTIONS))('the sentiment reaction %p does not delete', (emoji) => {
    expect(isDeleteReaction(emoji)).toBe(false)
    expect(sentimentForReaction(emoji)).toBeDefined()
  })

  test('both vocabularies normalise a variation selector the same way', () => {
    expect(isDeleteReaction('🔪\uFE0F')).toBe(true)
    expect(sentimentForReaction('👍\uFE0F')).toEqual({ name: 'thumbs_up', sentiment: 'POSITIVE' })
  })
})

describe('raindrop-payload: omitRepo', () => {
  test('false reports the project', () => {
    expect(ev({ omitRepo: false }).properties.repo).toBe('hydra')
  })

  test('true omits the field entirely rather than blanking it', () => {
    expect('repo' in ev({ omitRepo: true }).properties).toBe(false)
  })
})

describe('raindrop-payload: threadId gate', () => {
  test.each([
    'C0B6KKFNH4N:1779979488.572029 SSN 123-45-6789',
    'C0B6KKFNH4N:1779979488.572029 wire $2.4M to acme',
    `C0B6KKFNH4N:1779979488.572029 ${'x'.repeat(300)}`,
    'not a channel id at all',
    'C'.repeat(33),
    'C1:' + '1'.repeat(21) + '.123456',
    'C1:abcdefghij.klmnopq',
    'C1:1779979488.5720290',
    'C1:177997948.572029',
    'C1:1779979488X572029',
  ])('a poisoned chat_id %p is dropped from the wire', (threadId) => {
    const body = ev({ event: 'hydra.session.reply', threadId })
    expect('threadId' in body.properties).toBe(false)
  })

  test.each([
    'D0BE3RB4Y00:1789752921.353999',
    'C'.repeat(32),
    'C0B6KKFNH4N',
    '846209781206941736',
    'G01ABCDEF',
  ])('a real conversation id %p survives', (threadId) => {
    const body = ev({ event: 'hydra.session.reply', threadId })
    expect(body.properties.threadId).toBe(threadId)
  })
})

describe('raindrop-payload: model egress gate', () => {
  test.each(['claude-opus-5[1m]', 'gpt-6-astra'])('a catalogued model %s is reported', (model) => {
    expect(ev({ event: 'hydra.session.reply', facts: { ...facts, model }, threadId: 'c' }).properties.model).toBe(model)
  })

  test.each(['SSN 123-45-6789 Acme Corp $2.4M', '__proto__'])('uncatalogued free text %p is dropped', (model) => {
    expect('model' in ev({ event: 'hydra.session.reply', facts: { ...facts, model }, threadId: 'c' }).properties).toBe(false)
  })
})
