import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { rmSync } from 'fs'
import { join } from 'path'
import { STATE_DIR, gateway } from '../../../infra/config.js'
import { registry } from '../../../sessions/registry.js'
import { setSpecialistThread, _reloadSpecialists } from '../../../sessions/specialists.js'
import { _setHydraConfigForTesting } from '../../../infra/hydra-config.js'
import { getConversationTable, slackRuntimeDeps, stopSlackListener } from '../runtime.js'
import { TOP_LEVEL } from '../../../shared/slack-conversation.js'
import { executeTool } from '../../../app/bridge-dispatch.js'
import { TWO_APPS, hydra, view, SALES_BOT } from './slack-config.js'

process.stderr.write = (() => true) as any

// A restricted specialist on the second app (`sales`, pinned to it), one on the default app, and a plain session.
const CRM = 'crm-f'
const DEALS = 'deals-f'
const TOML = `${TWO_APPS}
[specialists.${CRM}]
workdir = "/w/crm"
reachable_by = ["role:anyone"]
[[rules]]
place = "slack:C1"
target = "specialist:${CRM}"
[specialists.${DEALS}]
workdir = "/w/deals"
pinned_to = ["app:sales"]
reachable_by = ["role:anyone"]
[[rules]]
place = "slack:C1"
target = "specialist:${DEALS}"
`

const reads: { channel: string; threadTs: string | undefined; limit: number; app: string | undefined; asOperator?: boolean }[] = []
const sessionIds: string[] = []
const session = (id: string, threadId: string, restricted = true, policy: Record<string, unknown> = {}) => {
  sessionIds.push(id)
  registry.set(id, { sessionId: id, tmuxName: id, threadId, sessionType: 'thread_owner', engine: 'claude', createdAt: Date.now(), policy: { restricted, ...policy } } as any)
}
const real = { read: slackRuntimeDeps.read, view: slackRuntimeDeps.view, post: slackRuntimeDeps.post, author: slackRuntimeDeps.author, edit: slackRuntimeDeps.edit, remove: slackRuntimeDeps.remove }
let discord: string[] = []
let spy: ReturnType<typeof spyOn> | undefined

beforeEach(() => {
  _setHydraConfigForTesting(hydra(TOML))
  const views = { default: view(TOML, { maxConversations: 5 }), sales: view(TOML, { maxConversations: 5, app: 'sales', botUserId: SALES_BOT }) }
  slackRuntimeDeps.view = (app = 'default') => (views as Record<string, ReturnType<typeof view>>)[app] ?? null
  reads.length = 0
  discord = []
  slackRuntimeDeps.read = async (channel, threadTs, limit, app, asOperator) => {
    reads.push({ channel, threadTs, limit, app, asOperator })
    return [
      { ts: '1795024671.118359', author: 'Bea', mine: false, text: 'what did step 2 do?', files: 0 },
      { ts: '1795024700.000001', author: 'me', mine: true, text: 'it filed\nthe report', files: 1 },
    ]
  }
  spy = spyOn(gateway, 'fetchMessages').mockImplementation((async (c: string) => { discord.push(c); return [] }) as any)
  setSpecialistThread(CRM, 'crm-thread-1')
  setSpecialistThread(DEALS, 'deals-thread-1')
  session('crm-session', 'crm-thread-1')
  session('deals-session', 'deals-thread-1')
  session('worker-session', 'worker-thread-1', false)
  getConversationTable().bind('C1', '5.000001', DEALS, 'tool', 'sales')
  getConversationTable().bind('C1', '6.000001', CRM, 'tool')
})
afterEach(() => {
  spy?.mockRestore()
  for (const e of getConversationTable().list()) getConversationTable().unwatch(e.channel, e.threadTs, e.app)
  for (const s of sessionIds.splice(0)) registry.delete(s)
  _setHydraConfigForTesting(undefined)
  rmSync(join(STATE_DIR, 'specialist-threads.json'), { force: true })
  _reloadSpecialists()
  Object.assign(slackRuntimeDeps, real)
  rmSync(join(STATE_DIR, 'slack-watches.json'), { force: true })
  stopSlackListener()
})

describe('fetch_messages on a Slack conversation reads it through the app that heard it', () => {
  test('a conversation of a second app is read through that app, not the chat gateway', async () => {
    const r = await executeTool('fetch_messages', { channel: 'slack:sales:C1:5.000001', limit: 30 }, 'deals-session')
    expect(r.isError).toBeUndefined()
    expect(reads).toEqual([{ channel: 'C1', threadTs: '5.000001', limit: 30, app: 'sales', asOperator: true }])
    expect(discord).toEqual([])
    expect(r.content[0].text).toBe([
      `[${new Date(1795024671118).toISOString()}] Bea: what did step 2 do?  (id: 1795024671.118359)`,
      `[${new Date(1795024700000).toISOString()}] me: it filed ⏎ the report  (id: 1795024700.000001 +1att)`,
    ].join('\n'))
  })

  test('a conversation of the default app is read through the default app', async () => {
    await executeTool('fetch_messages', { channel: 'slack:C1:6.000001' }, 'crm-session')
    expect(reads).toEqual([{ channel: 'C1', threadTs: '6.000001', limit: 20, app: 'default', asOperator: true }])
    expect(discord).toEqual([])
  })

  test('a conversation not bound to the session is refused before Slack is asked', async () => {
    // Another specialist's; and the same thread named without its app, which is a different (unbound) conversation.
    for (const [channel, who] of [['slack:sales:C1:5.000001', 'crm-session'], ['slack:C1:5.000001', 'deals-session'], ['slack:C1:9.000001', 'crm-session']]) {
      const r = await executeTool('fetch_messages', { channel }, who)
      expect(r.isError).toBe(true)
      expect(r.content[0].text).toContain("is not this session's own conversation")
    }
    // A read's refusal names why, and offers no home_place way in, as a reply's once did.
    const why = (await executeTool('fetch_messages', { channel: 'slack:sales:C1:5.000001' }, 'crm-session')).content[0].text
    expect(why).toContain(`is bound to ${DEALS}, not ${CRM}: a read goes only to a conversation bound to your specialist`)
    expect(why).not.toContain('home_place')
    expect(reads).toEqual([])
    expect(discord).toEqual([])
  })

  test('a channel or DM conversation (no thread) is read at its top level', async () => {
    getConversationTable().bind('D1', TOP_LEVEL, CRM, 'tool')
    await executeTool('fetch_messages', { channel: 'slack:D1' }, 'crm-session')
    await executeTool('fetch_messages', { channel: 'slack:sales:C9', limit: 500 }, 'worker-session')
    expect(reads).toEqual([
      { channel: 'D1', threadTs: undefined, limit: 20, app: 'default', asOperator: true },
      { channel: 'C9', threadTs: undefined, limit: 100, app: 'sales', asOperator: false },
    ])
  })

  test('a session that is not a restricted specialist, and main, read any conversation of a declared app; an undeclared app is refused', async () => {
    await executeTool('fetch_messages', { channel: 'slack:sales:C9:3.000001' }, 'worker-session')
    await executeTool('fetch_messages', { channel: 'slack:C1:5.000001' }, 'main')
    expect(reads.map(r => r.app)).toEqual(['sales', 'default'])
    const r = await executeTool('fetch_messages', { channel: 'slack:nope:C9:3.000001' }, 'worker-session')
    expect(r.isError).toBe(true)
    expect(reads).toHaveLength(2)
  })

  test('Slack’s refusal is named with the conversation and the app', async () => {
    slackRuntimeDeps.read = async () => { throw new Error('An API error occurred: not_in_channel') }
    const r = await executeTool('fetch_messages', { channel: 'slack:sales:C1:5.000001' }, 'deals-session')
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain('fetch_messages failed for slack:sales:C1:5.000001 through')
    expect(r.content[0].text).toContain('not_in_channel')
  })

  test('a Discord channel id still goes to the chat gateway', async () => {
    await executeTool('fetch_messages', { channel: '1234567890123456789', limit: 5 }, 'worker-session')
    expect(discord).toEqual(['1234567890123456789'])
    expect(reads).toEqual([])
  })
})

describe('a session held to its own conversations reads only them', () => {
  const OTHERS = '7.000001'   // a top-level message in C1 tagged for DEALS: its thread is DEALS's
  beforeEach(() => {
    getConversationTable().watch('C1', TOP_LEVEL, CRM, 'chatter')   // C1's untagged top level (messages = "all") is CRM's
    getConversationTable().watch('C1', OTHERS, DEALS, 'mention', 'sales')
    session('crm-confined', 'crm-thread-1', false, { canOnlyWriteTo: ['/w/crm'] })
  })

  test('a specialist bound to slack:C1 cannot read a C1 message tagged for another specialist, through any id form', async () => {
    const forms = ['slack:C1', 'slack:default:C1', ' slack:C1', 'slack:C1 ', `slack:C1:${OTHERS}`, `slack:default:C1:${OTHERS}`, ` slack:C1:${OTHERS}`, `slack:sales:C1:${OTHERS}`, 'slack:sales:C1', `slack:C1:${OTHERS} `]
    for (const who of ['crm-session', 'crm-confined']) for (const channel of forms) {
      const r = await executeTool('fetch_messages', { channel }, who)
      expect([who, channel, r.isError]).toEqual([who, channel, true])
    }
    expect((await executeTool('fetch_messages', { channel: 'slack:C1' }, 'crm-session')).content[0].text).toContain("(slack:C1 is a channel's top level, which holds every top-level message there, others' too: a read goes only to a thread bound to your specialist (slack:C1:<thread ts>) or a DM")
    expect(reads).toEqual([])
    expect(discord).toEqual([])
  })

  test('a caller with no record that did not declare itself restricted is held as a restricted one is', async () => {
    for (const channel of ['slack:C1', `slack:sales:C1:${OTHERS}`, 'slack:C1:6.000001']) {
      const r = await executeTool('fetch_messages', { channel }, 'stray-bridge')
      expect([channel, r.isError]).toEqual([channel, true])
    }
    expect(reads).toEqual([])
  })

  test('its own thread and a DM’s top level stay readable; a session not held reads a channel’s top level', async () => {
    getConversationTable().watch('D1', TOP_LEVEL, CRM, 'dm')
    for (const who of ['crm-session', 'crm-confined']) {
      expect((await executeTool('fetch_messages', { channel: 'slack:C1:6.000001' }, who)).isError).toBeUndefined()
      expect((await executeTool('fetch_messages', { channel: 'slack:D1' }, who)).isError).toBeUndefined()
    }
    expect((await executeTool('fetch_messages', { channel: 'slack:C1' }, 'worker-session')).isError).toBeUndefined()
    expect(reads.map(r => [r.channel, r.threadTs])).toEqual([['C1', '6.000001'], ['D1', undefined], ['C1', '6.000001'], ['D1', undefined], ['C1', undefined]])
  })
})

describe('the operator’s token reads only a conversation hydra holds', () => {
  beforeEach(() => {
    // The bot is in no channel; the operator's token reads anything, the operator's own DMs and groups too.
    slackRuntimeDeps.read = async (channel, threadTs, limit, app, asOperator) => {
      reads.push({ channel, threadTs, limit, app, asOperator })
      if (!asOperator) throw new Error('An API error occurred: not_in_channel')
      return [{ ts: '5.000001', author: 'Bea', mine: false, text: 'hi', files: 0 }]
    }
  })

  test('a bound thread the bot is not in is read as the operator', async () => {
    const r = await executeTool('fetch_messages', { channel: 'slack:sales:C1:5.000001' }, 'worker-session')
    expect(r.isError).toBeUndefined()
    expect(reads).toEqual([{ channel: 'C1', threadTs: '5.000001', limit: 20, app: 'sales', asOperator: true }])
  })

  test('an unbound thread the bot is not in is refused; the operator’s token is never offered', async () => {
    // With no operator token, binding can't help: the operator is asked to invite the bot.
    const r = await executeTool('fetch_messages', { channel: 'slack:sales:G9:3.000001' }, 'worker-session')
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain("its bot isn't in")
    expect(r.content[0].text).toContain("the operator's token reads only a conversation hydra holds. Ask the operator to invite the bot to")
    expect(r.content[0].text).not.toContain('bind_conversation')
    // With one, the refusal says how to bind it, and what binding brings.
    _setHydraConfigForTesting(hydra(TOML.replace('socket_token_env = "SALES_SLACK_APP_TOKEN"', 'socket_token_env = "SALES_SLACK_APP_TOKEN"\noperator_token_env = "SALES_USER"')))
    const bindable = await executeTool('fetch_messages', { channel: 'slack:sales:G9:3.000001' }, 'worker-session')
    expect(bindable.content[0].text).toContain('Bind it first (bind_conversation(conversation="slack:sales:G9:3.000001")), then read it: a bound thread is read as the operator, and its new messages are delivered to this session until it is idle a week')
    expect(reads.map(r => r.asOperator)).toEqual([false, false])
  })
})

describe('a slack: id is routed as it is checked', () => {
  const posted: string[] = []
  const gatewayCalls: string[] = []
  const spies: ReturnType<typeof spyOn>[] = []
  beforeEach(() => {
    posted.length = 0
    gatewayCalls.length = 0
    slackRuntimeDeps.post = async (channel, threadTs, text, app) => { posted.push(`post:${app}:${channel}:${threadTs}:${text}`); return '9.000001' }
    slackRuntimeDeps.author = async () => 'app'
    slackRuntimeDeps.edit = async (channel, ts, text, app) => { posted.push(`edit:${app}:${channel}:${ts}:${text}`) }
    slackRuntimeDeps.remove = async (channel, ts, app) => { posted.push(`remove:${app}:${channel}:${ts}`) }
    spies.push(spyOn(gateway, 'fetchChannel').mockImplementation((async (c: string) => { gatewayCalls.push(`fetchChannel:${c}`); throw new Error('gateway') }) as any))
    spies.push(spyOn(gateway, 'edit').mockImplementation((async (c: string) => { gatewayCalls.push(`edit:${c}`); return 'x' }) as any))
    spies.push(spyOn(gateway, 'delete').mockImplementation((async (c: string) => { gatewayCalls.push(`delete:${c}`) }) as any))
  })
  afterEach(() => { for (const s of spies.splice(0)) s.mockRestore() })

  test('with a leading space, fetch_messages, reply, edit_message and delete_message all go to Slack, never the chat gateway', async () => {
    const id = ' slack:C1:6.000001'
    for (const [tool, args] of [
      ['fetch_messages', { channel: id }],
      ['reply', { chat_id: id, text: 'hello' }],
      ['edit_message', { chat_id: id, message_id: '9.000001', text: 'new' }],
      ['delete_message', { chat_id: id, message_id: '9.000001' }],
    ] as const) {
      for (const who of tool === 'reply' ? ['crm-session'] : ['crm-session', 'worker-session']) {
        const r = await executeTool(tool, { ...args }, who)
        expect([tool, who, r.isError]).toEqual([tool, who, undefined])
      }
    }
    expect(discord).toEqual([])
    expect(gatewayCalls).toEqual([])
    expect(reads.map(r => r.threadTs)).toEqual(['6.000001', '6.000001'])
    expect(posted).toEqual([
      'post:default:C1:6.000001:hello',
      'edit:default:C1:9.000001:new', 'edit:default:C1:9.000001:new',
      'remove:default:C1:9.000001', 'remove:default:C1:9.000001',
    ])
  })
})

describe('fetch_messages’ limit', () => {
  test('a limit that is not a number of messages is refused before anything is read; a large one is cut to 100', async () => {
    for (const limit of ['abc', '30', 0, -5, Number.NaN, Infinity]) {
      const r = await executeTool('fetch_messages', { channel: 'slack:C1:6.000001', limit }, 'crm-session')
      expect(r.isError).toBe(true)
      expect(r.content[0].text).toContain('is not a number of messages: pass a whole number from 1 to 100 (20 when left out)')
    }
    const d = await executeTool('fetch_messages', { channel: '1234567890123456789', limit: 'abc' }, 'worker-session')
    expect(d.isError).toBe(true)
    expect(reads).toEqual([])
    expect(discord).toEqual([])
    await executeTool('fetch_messages', { channel: 'slack:C1:6.000001', limit: 2.7 }, 'crm-session')
    await executeTool('fetch_messages', { channel: 'slack:C1:6.000001', limit: 1000 }, 'crm-session')
    expect(reads.map(r => r.limit)).toEqual([2, 100])
  })
})
