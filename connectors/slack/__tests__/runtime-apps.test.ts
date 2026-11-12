import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { rmSync } from 'fs'
import { join } from 'path'
import { STATE_DIR, gateway } from '../../../daemon/config.js'
import { registry } from '../../../daemon/sessions.js'
import { setSpecialistThread, _reloadSpecialists } from '../../../specialists/specialists.js'
import { _setHydraConfigForTesting } from '../../../daemon/hydra-config.js'
import {
  getSlackWatcher, bindConversation, formatConversations, operatorBind, operatorUnbind, slackRuntimeDeps, replyInConversation, startSlackListener, stopSlackListener,
} from '../runtime.js'
import { sessionCapabilities } from '../../../daemon/tool-surface.js'
import { BASE, TWO_APPS, hydra, view, SALES_BOT } from './slack-config.js'
import { SlackWatcher } from '../watch.js'

process.stderr.write = (() => true) as any

const CRM = 'crm-t'
const DEALS = 'deals-t'
const CRM_THREAD = 'crm-thread-1'
const DEALS_THREAD = 'deals-thread-1'
const TOML = `${TWO_APPS}
[specialists.${CRM}]
workdir = "/w/crm"
listens = ["slack:C1"]
allow = ["anyone"]
home = "slack:C9"
[specialists.${DEALS}]
workdir = "/w/deals"
apps = ["sales"]
listens = ["slack:C1"]
allow = ["anyone"]
home = "slack:C8"
`
const crm = { threadId: CRM_THREAD }
const deals = { threadId: DEALS_THREAD }

type Post = { channel: string; thread: string | undefined; text: string; app: string | undefined }
const posts: Post[] = []
const sessionIds: string[] = []
const session = (id: string, threadId: string) => {
  sessionIds.push(id)
  registry.set(id, { sessionId: id, tmuxName: id, threadId, sessionType: 'thread_owner', engine: 'claude', createdAt: Date.now() } as any)
}
/** One connected view per app: what each app's listener would hand the runtime. */
function configure(toml = TOML, via: Record<string, 'bot' | 'user' | null> = {}) {
  _setHydraConfigForTesting(hydra(toml))
  const views = { default: view(toml, { maxWatches: 5 }), sales: view(toml, { maxWatches: 5, app: 'sales', botUserId: SALES_BOT }) }
  slackRuntimeDeps.view = (app = 'default') => (views as Record<string, ReturnType<typeof view>>)[app] ?? null
  slackRuntimeDeps.readThread = async (_c, _t, app = 'default') => via[app] === undefined ? 'bot' : via[app]
}
const realPost = slackRuntimeDeps.post
const realRead = slackRuntimeDeps.readThread
beforeEach(() => {
  configure()
  posts.length = 0
  slackRuntimeDeps.post = async (channel, thread, text, app) => { posts.push({ channel, thread, text, app }); return '77.000001' }
  setSpecialistThread(CRM, CRM_THREAD)
  setSpecialistThread(DEALS, DEALS_THREAD)
  session('crm-session', CRM_THREAD)
  session('deals-session', DEALS_THREAD)
})
afterEach(() => {
  for (const e of getSlackWatcher().list()) getSlackWatcher().unwatch(e.channel, e.threadTs, e.app)
  for (const s of sessionIds.splice(0)) registry.delete(s)
  _setHydraConfigForTesting(undefined)
  rmSync(join(STATE_DIR, 'specialist-threads.json'), { force: true })
  _reloadSpecialists()
  slackRuntimeDeps.view = () => null
  slackRuntimeDeps.post = realPost
  slackRuntimeDeps.readThread = realRead
  rmSync(join(STATE_DIR, 'slack-watches.json'), { force: true })
  stopSlackListener()
})

describe('replies leave through the app that heard the conversation', () => {
  test('a conversation of app sales posts with sales’s client, and one of `default` with `default`’s', async () => {
    getSlackWatcher().bind('C1', '5.000001', DEALS, 'tool', 'sales')
    getSlackWatcher().bind('C1', '6.000001', CRM, 'tool')
    expect(await replyInConversation('deals-session', 'slack:sales:C1:5.000001', 'a quote')).toBe('posted 1 message to slack:sales:C1:5.000001')
    expect(await replyInConversation('crm-session', 'slack:C1:6.000001', 'a call')).toBe('posted 1 message to slack:C1:6.000001')
    expect(posts).toEqual([
      { channel: 'C1', thread: '5.000001', text: 'a quote', app: 'sales' },
      { channel: 'C1', thread: '6.000001', text: 'a call', app: 'default' },
    ])
  })

  test('a conversation is one app’s: the same thread named for another app is not open', async () => {
    getSlackWatcher().bind('C1', '5.000001', DEALS, 'tool', 'sales')
    await expect(replyInConversation('deals-session', 'slack:C1:5.000001', 'x')).rejects.toThrow('slack:C1:5.000001 is not an open conversation')
    expect(posts).toEqual([])
  })

  test('a specialist answers only conversations bound to it, whichever app they came through', async () => {
    getSlackWatcher().bind('C1', '5.000001', DEALS, 'tool', 'sales')
    await expect(replyInConversation('crm-session', 'slack:sales:C1:5.000001', 'x')).rejects.toThrow(`slack:sales:C1:5.000001 is bound to ${DEALS}, not ${CRM}`)
    expect(posts).toEqual([])
  })

  test('an app that is not connected is said by name, and posts nothing through another', async () => {
    slackRuntimeDeps.post = realPost
    getSlackWatcher().bind('C1', '5.000001', DEALS, 'tool', 'sales')
    await expect(replyInConversation('deals-session', 'slack:sales:C1:5.000001', 'x')).rejects.toThrow('Slack is not connected for the app named `sales`')
  })
})

describe('a post with no incoming message speaks as the specialist’s app', () => {
  const home = (extra: string) => TOML.replace(`home = "slack:C8"`, `home = "slack:C8"\n${extra}`)
  test('speaks_as picks the app; absent, a pinned specialist speaks as its pinned app and an unpinned one as `default`', async () => {
    expect(await replyInConversation('deals-session', 'slack:C8', 'hello')).toContain('posted to deals-t\'s home')
    expect(await replyInConversation('crm-session', 'slack:C9', 'hello')).toContain('posted to crm-t\'s home')
    expect(posts.map(p => [p.channel, p.app])).toEqual([['C8', 'sales'], ['C9', 'default']])
    // Its thread is a conversation of the app it spoke through.
    expect(getSlackWatcher().get('C8', '77.000001', 'sales')).toMatchObject({ specialist: DEALS, mentionedBy: 'home', app: 'sales' })
    expect(getSlackWatcher().get('C9', '77.000001')).toMatchObject({ specialist: CRM, mentionedBy: 'home' })
    expect(getSlackWatcher().get('C9', '77.000001')).not.toHaveProperty('app')
  })

  test('speaks_as overrides it, and the sales home can be named in the app’s own form', async () => {
    configure(TOML.replace(`[specialists.${CRM}]\nworkdir = "/w/crm"\nlistens = ["slack:C1"]`, `[specialists.${CRM}]\nworkdir = "/w/crm"\napps = ["default"]\nlistens = ["slack:C2"]`).replace(`apps = ["sales"]`, `apps = ["sales", "default"]\nspeaks_as = "default"`))
    await replyInConversation('deals-session', 'slack:C8', 'hello')
    expect(posts.map(p => p.app)).toEqual(['default'])
    posts.length = 0
    configure()
    await replyInConversation('deals-session', 'slack:sales:C8', 'hello')
    expect(posts.map(p => p.app)).toEqual(['sales'])
  })
})

describe('a pinned specialist cannot be reached through another app', () => {
  test('a specialist session binds only through its own apps, and says why', async () => {
    await expect(bindConversation(deals, 'slack:C1:5.000001')).rejects.toThrow('deals-t is pinned to app sales, and this conversation is through app default')
    await expect(bindConversation(crm, 'slack:sales:C1:5.000001')).rejects.toThrow('app sales serves only specialists pinned to it (deals-t), and crm-t is not pinned')
    expect(await bindConversation(deals, 'slack:sales:C1:5.000001')).toStartWith(`slack:sales:C1:5.000001 is bound to ${DEALS}`)
    expect(getSlackWatcher().get('C1', '5.000001', 'sales')?.specialist).toBe(DEALS)
    expect(await bindConversation(crm, 'slack:C1:6.000001')).toStartWith(`slack:C1:6.000001 is bound to ${CRM}`)
  })

  test('a bind names an app hydra.toml declares', async () => {
    await expect(bindConversation(deals, 'slack:ghost:C1:5.000001')).rejects.toThrow('no app "ghost": declare [slack.apps.ghost]; hydra.toml declares default, sales')
  })

  test('the operator’s bind carries the app, and refuses a specialist pinned elsewhere, or an app that is not declared', () => {
    expect(() => operatorBind('slack:C1:5.000001', DEALS)).toThrow('deals-t is pinned to app sales, and this conversation is through app default')
    expect(() => operatorBind('slack:sales:C1:5.000001', CRM)).toThrow('app sales serves only specialists pinned to it')
    expect(() => operatorBind('slack:ghost:C1:5.000001', DEALS)).toThrow('no app "ghost"')
    expect(operatorBind('slack:sales:C1:5.000001', DEALS)).toBe(`slack:sales:C1:5.000001 → ${DEALS}`)
    expect(operatorBind('slack:C1:5.000001', CRM)).toBe(`slack:C1:5.000001 → ${CRM}`)
    expect(getSlackWatcher().list().map(e => [e.app, e.specialist])).toEqual([['sales', DEALS], [undefined, CRM]])
    // main is exempt from pinning.
    expect(operatorBind('slack:sales:C1:7.000001', 'main')).toBe('slack:sales:C1:7.000001 → main')
    expect(operatorUnbind('slack:sales:C1:5.000001')).toBe('slack:sales:C1:5.000001 is unbound')
    expect(getSlackWatcher().get('C1', '5.000001', 'sales')).toBeUndefined()
    expect(getSlackWatcher().get('C1', '5.000001')?.specialist).toBe(CRM)
  })

  test('the list prints every conversation in its own id, the app first where it is not `default`', () => {
    operatorBind('slack:sales:C1:5.000001', DEALS)
    operatorBind('slack:C1:6.000001', CRM)
    const lines = formatConversations()
    expect(lines[0]).toStartWith(`slack:sales:C1:5.000001 (slack:C1) → ${DEALS}`)
    expect(lines[1]).toStartWith(`slack:C1:6.000001 (slack:C1) → ${CRM}`)
  })
})

describe('Slack is on when any app is declared', () => {
  test('a hydra.toml whose only app is not named `default` still gives sessions the conversation tools', () => {
    const only = `operator = "op"
[slack.apps.sales]
bot_token_env = "SALES_SLACK_BOT_TOKEN"
app_token_env = "SALES_SLACK_APP_TOKEN"
[people.op]
ids = ["slack:UOP"]
[specialists.${CRM}]
workdir = "/w/crm"
listens = ["slack:C1"]
allow = ["anyone"]
`
    _setHydraConfigForTesting(hydra(only))
    expect(sessionCapabilities({ threadId: CRM_THREAD, capabilities: [], engine: 'claude' } as any).has('conversations')).toBe(true)
  })
})

describe('connecting one listener per app', () => {
  test('an app with no tokens is skipped, with an alert that names the key to fix, once', async () => {
    const told: [string, string][] = []
    const realSend = gateway.send
    ;(gateway as any).send = async (c: string, text: string) => { told.push([c, text]); return 'id' }
    try {
      await startSlackListener()
      await startSlackListener()
      await Bun.sleep(5)
      const said = told.filter(([, t]) => t.includes('Slack is not connected for the app named'))
      // Each Slack-hearing specialist is told, once per app: two apps, two specialists.
      expect(said.filter(([, t]) => t.includes('`sales`') && t.includes('`bot_token_env` of the app named `sales` (`[slack.apps.sales]`) names SALES_SLACK_BOT_TOKEN'))).toHaveLength(2)
      expect(said.filter(([, t]) => t.includes('app named `default`') && t.includes('SLOPBOT_SLACK_BOT_TOKEN'))).toHaveLength(2)
    } finally { (gateway as any).send = realSend }
  })
})

describe('the store keeps an app’s conversations apart', () => {
  test('the same channel and thread through two apps are two entries, each unwatched on its own', () => {
    const w: SlackWatcher = getSlackWatcher()
    w.bind('C1', '5.000001', DEALS, 'tool', 'sales')
    w.bind('C1', '5.000001', CRM, 'tool')
    expect(w.list()).toHaveLength(2)
    expect(w.unwatch('C1', '5.000001', 'sales')).toBe(true)
    expect(w.get('C1', '5.000001')?.specialist).toBe(CRM)
  })
})
