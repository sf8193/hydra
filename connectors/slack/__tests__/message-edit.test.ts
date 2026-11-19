import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { rmSync } from 'fs'
import { join } from 'path'
import { STATE_DIR } from '../../../daemon/config.js'
import { registry } from '../../../daemon/sessions.js'
import { setSpecialistThread, _reloadSpecialists } from '../../../specialists/specialists.js'
import { _setHydraConfigForTesting } from '../../../daemon/hydra-config.js'
import { getConversationTable, slackRuntimeDeps, editInConversation, deleteInConversation, stopSlackListener } from '../runtime.js'
import { executeTool } from '../../../daemon/bridge-dispatch.js'
import type { MessageAuthor, Writer } from '../listener.js'
import { TWO_APPS, hydra, view, SALES_BOT } from './slack-config.js'

process.stderr.write = (() => true) as any

const CRM = 'crm-t'
const DEALS = 'deals-t'
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

type Call = { verb: 'edit' | 'delete'; channel: string; ts: string; text?: string; app: string | undefined; as: Writer | undefined }
const calls: Call[] = []
const reads: { channel: string; ts: string; threadTs: string | undefined; app: string | undefined }[] = []
/** Whose each message is; what Slack answers a write with, when it refuses. */
const state = { author: 'app' as MessageAuthor, refuse: undefined as string | undefined, byApp: undefined as Record<string, MessageAuthor> | undefined }
const sessionIds: string[] = []
/** A restricted specialist's session, unless `restricted` is false: a plain session. */
const session = (id: string, threadId: string, restricted = true) => {
  sessionIds.push(id)
  registry.set(id, { sessionId: id, tmuxName: id, threadId, sessionType: 'thread_owner', engine: 'claude', createdAt: Date.now(), policy: { restricted } } as any)
}
const real = { author: slackRuntimeDeps.author, edit: slackRuntimeDeps.edit, remove: slackRuntimeDeps.remove, view: slackRuntimeDeps.view }

beforeEach(() => {
  _setHydraConfigForTesting(hydra(TOML))
  const views = { default: view(TOML, { maxConversations: 5 }), sales: view(TOML, { maxConversations: 5, app: 'sales', botUserId: SALES_BOT }) }
  slackRuntimeDeps.view = (app = 'default') => (views as Record<string, ReturnType<typeof view>>)[app] ?? null
  calls.length = 0
  reads.length = 0
  state.author = 'app'
  state.refuse = undefined
  state.byApp = undefined
  slackRuntimeDeps.author = async (channel, ts, threadTs, app) => { reads.push({ channel, ts, threadTs, app }); return state.byApp ? state.byApp[app ?? 'default'] ?? 'other' : state.author }
  slackRuntimeDeps.edit = async (channel, ts, text, app, as) => { if (state.refuse) throw new Error(state.refuse); calls.push({ verb: 'edit', channel, ts, text, app, as }) }
  slackRuntimeDeps.remove = async (channel, ts, app, as) => { if (state.refuse) throw new Error(state.refuse); calls.push({ verb: 'delete', channel, ts, app, as }) }
  setSpecialistThread(CRM, 'crm-thread-1')
  setSpecialistThread(DEALS, 'deals-thread-1')
  session('crm-session', 'crm-thread-1')
  session('deals-session', 'deals-thread-1')
  session('worker-session', 'worker-thread-1', false)
  getConversationTable().bind('C1', '5.000001', DEALS, 'tool', 'sales')
  getConversationTable().bind('C1', '6.000001', CRM, 'tool')
  getConversationTable().bind('C1', '7.000001', 'main', 'tool')
})
afterEach(() => {
  for (const e of getConversationTable().list()) getConversationTable().unwatch(e.channel, e.threadTs, e.app)
  for (const s of sessionIds.splice(0)) registry.delete(s)
  _setHydraConfigForTesting(undefined)
  rmSync(join(STATE_DIR, 'specialist-threads.json'), { force: true })
  _reloadSpecialists()
  Object.assign(slackRuntimeDeps, real)
  rmSync(join(STATE_DIR, 'slack-watches.json'), { force: true })
  stopSlackListener()
})

describe('a session edits and deletes the messages its own app posted', () => {
  test('through the app that heard the conversation, as that app’s bot', async () => {
    expect(await editInConversation('deals-session', 'slack:sales:C1:5.000001', '8.000001', 'quote v2')).toBe('edited 8.000001 in slack:sales:C1:5.000001')
    expect(await deleteInConversation('crm-session', 'slack:C1:6.000001', '9.000001')).toBe('deleted 9.000001 in slack:C1:6.000001')
    expect(calls).toEqual([
      { verb: 'edit', channel: 'C1', ts: '8.000001', text: 'quote v2', app: 'sales', as: 'app' },
      { verb: 'delete', channel: 'C1', ts: '9.000001', app: 'default', as: 'app' },
    ])
    // The author is asked of the thread the conversation is.
    expect(reads).toEqual([
      { channel: 'C1', ts: '8.000001', threadTs: '5.000001', app: 'sales' },
      { channel: 'C1', ts: '9.000001', threadTs: '6.000001', app: 'default' },
    ])
  })

  test('only in a conversation bound to it, as reply holds: another’s, or one not open, is refused before Slack is asked', async () => {
    // Held at the dispatcher, the one place a restricted session's tools are checked.
    expect((await executeTool('edit_message', { chat_id: 'slack:sales:C1:5.000001', message_id: '8.000001', text: 'x' }, 'crm-session')).content[0].text).toContain(`slack:sales:C1:5.000001 is bound to ${DEALS}, not ${CRM}`)
    expect((await executeTool('delete_message', { chat_id: 'slack:C1:5.000001', message_id: '8.000001' }, 'deals-session')).content[0].text).toContain('slack:C1:5.000001 is not an open conversation')
    expect(reads).toEqual([])
    expect(calls).toEqual([])
  })

  test('a message that is neither the app’s nor the operator’s is refused, and Slack is not asked to touch it', async () => {
    state.author = 'other'
    await expect(editInConversation('crm-session', 'slack:C1:6.000001', '8.000001', 'x')).rejects.toThrow('was written by neither')
    await expect(deleteInConversation('crm-session', 'slack:C1:6.000001', '8.000001')).rejects.toThrow('a restricted specialist may delete only its own app')
    expect(calls).toEqual([])
  })

  test('Slack’s own refusal is surfaced plainly', async () => {
    state.refuse = 'An API error occurred: cant_update_message'
    await expect(editInConversation('crm-session', 'slack:C1:6.000001', '8.000001', 'x')).rejects.toThrow('edit failed: An API error occurred: cant_update_message')
    await expect(deleteInConversation('crm-session', 'slack:C1:6.000001', '8.000001')).rejects.toThrow('delete failed: An API error occurred: cant_update_message')
  })

  test('a bad message_id, an empty edit and one over a message’s length are refused before Slack is asked', async () => {
    await expect(editInConversation('crm-session', 'slack:C1:6.000001', 'not-a-ts', 'x')).rejects.toThrow('is not a Slack message ts')
    await expect(deleteInConversation('crm-session', 'slack:C1:6.000001', undefined)).rejects.toThrow('is not a Slack message ts')
    await expect(editInConversation('crm-session', 'slack:C1:6.000001', '8.000001', '  ')).rejects.toThrow('the text is empty')
    await expect(editInConversation('crm-session', 'slack:C1:6.000001', '8.000001', 'x'.repeat(4000))).rejects.toThrow('an edit is one message')
    expect(reads).toEqual([])
  })

  test('a ts is taken exactly: one short of Slack’s six digits is refused, not completed into another message', async () => {
    await expect(editInConversation('crm-session', 'slack:C1:6.000001', '8.5', 'x')).rejects.toThrow('six digits after the point')
    expect(reads).toEqual([])
  })

  test('a missing text is a refusal, not a crash; the refusals say edit or delete, not reply', async () => {
    await expect(editInConversation('crm-session', 'slack:C1:6.000001', '8.000001', undefined as unknown as string)).rejects.toThrow('the text is empty')
    await expect(editInConversation('crm-session', 'slack:sales:C1:5.000001', '8.000001', 'x')).rejects.toThrow('an edit goes only to a conversation bound to your specialist')
    await expect(deleteInConversation('crm-session', 'slack:sales:C1:5.000001', '8.000001')).rejects.toThrow('a delete goes only to a conversation bound to your specialist')
  })

  test('a conversation unbound while Slack is being asked gets no write', async () => {
    slackRuntimeDeps.author = async () => { getConversationTable().unwatch('C1', '6.000001', undefined); return 'app' }
    await expect(editInConversation('crm-session', 'slack:C1:6.000001', '8.000001', 'x')).rejects.toThrow('is no longer an open conversation: nothing was edited')
    getConversationTable().bind('C1', '6.000001', CRM, 'tool')
    slackRuntimeDeps.author = async () => { getConversationTable().bind('C1', '6.000001', DEALS, 'cli'); return 'app' }
    await expect(deleteInConversation('crm-session', 'slack:C1:6.000001', '8.000001')).rejects.toThrow(`is bound to ${DEALS}, not ${CRM}`)
    expect(calls).toEqual([])
  })
})

describe('the operator’s own messages: a restricted specialist never touches them', () => {
  beforeEach(() => { state.author = 'operator' })

  test('main edits and deletes one in a conversation bound to it, with the operator’s token', async () => {
    expect(await editInConversation('main', 'slack:C1:7.000001', '8.000001', 'fixed')).toBe('edited 8.000001 in slack:C1:7.000001')
    expect(await deleteInConversation('main', 'slack:C1:7.000001', '8.000001')).toBe('deleted 8.000001 in slack:C1:7.000001')
    expect(calls).toEqual([
      { verb: 'edit', channel: 'C1', ts: '8.000001', text: 'fixed', app: 'default', as: 'operator' },
      { verb: 'delete', channel: 'C1', ts: '8.000001', app: 'default', as: 'operator' },
    ])
  })

  test('a restricted specialist is refused, and the operator’s token is not used', async () => {
    await expect(editInConversation('crm-session', 'slack:C1:6.000001', '8.000001', 'x')).rejects.toThrow("is the operator's own message: a restricted specialist may edit only its own app's posts")
    await expect(deleteInConversation('deals-session', 'slack:sales:C1:5.000001', '8.000001')).rejects.toThrow("a restricted specialist may delete only its own app's posts")
    expect(calls).toEqual([])
  })

  test('a restricted specialist is held to the conversation rule: one bound to another is refused before Slack is asked', async () => {
    expect((await executeTool('edit_message', { chat_id: 'slack:C1:7.000001', message_id: '8.000001', text: 'x' }, 'crm-session')).content[0].text).toContain(`slack:C1:7.000001 is bound to main, not ${CRM}`)
    expect(reads).toEqual([])
  })

  test('a session that is not a restricted specialist edits and deletes one in a channel no conversation is bound in', async () => {
    expect(await editInConversation('worker-session', 'slack:C9', '8.000001', 'fixed')).toBe('edited 8.000001 in slack:C9')
    expect(await deleteInConversation('worker-session', 'slack:C9:3.000001', '8.000001')).toBe('deleted 8.000001 in slack:C9:3.000001')
    expect(calls).toEqual([
      { verb: 'edit', channel: 'C9', ts: '8.000001', text: 'fixed', app: 'default', as: 'operator' },
      { verb: 'delete', channel: 'C9', ts: '8.000001', app: 'default', as: 'operator' },
    ])
  })

  test('with no app named, the operator’s message goes through the app that holds the operator’s token', async () => {
    state.byApp = { default: 'other', sales: 'operator' }
    await editInConversation('worker-session', 'slack:C9', '8.000001', 'fixed')
    expect(calls).toEqual([{ verb: 'edit', channel: 'C9', ts: '8.000001', text: 'fixed', app: 'sales', as: 'operator' }])
  })

  test('a token without the write scope is refused naming the scope, and that the app must be reinstalled', async () => {
    state.refuse = 'missing_scope: the token needs chat:write and has channels:history,im:read'
    const err = await editInConversation('main', 'slack:C1:7.000001', '8.000001', 'x').then(() => new Error('resolved'), (e: Error) => e)
    expect(err.message).toContain('lacks the user scope chat:write')
    expect(err.message).toContain('reinstall the app')
    expect(err.message).toContain('hydra slack manifest default')
    await expect(deleteInConversation('main', 'slack:C1:7.000001', '8.000001')).rejects.toThrow('lacks the user scope chat:write')
  })

  test('the same refusal from the bot’s own token is not mistaken for the operator’s scope', async () => {
    state.author = 'app'
    state.refuse = 'missing_scope: the token needs chat:write and has channels:history'
    await expect(editInConversation('main', 'slack:C1:7.000001', '8.000001', 'x')).rejects.toThrow('edit failed: missing_scope')
  })
})

describe('any message an app’s bot posted, in any conversation, by a session that is not a restricted specialist', () => {
  test('in a channel no conversation is bound in, with the bot token of the app whose bot wrote it', async () => {
    state.byApp = { default: 'other', sales: 'app' }
    expect(await editInConversation('worker-session', 'slack:C9:3.000001', '8.000001', 'v2')).toBe('edited 8.000001 in slack:C9:3.000001')
    state.byApp = { default: 'app', sales: 'other' }
    await deleteInConversation('main', 'slack:C9', '8.000001')
    expect(calls).toEqual([
      { verb: 'edit', channel: 'C9', ts: '8.000001', text: 'v2', app: 'sales', as: 'app' },
      { verb: 'delete', channel: 'C9', ts: '8.000001', app: 'default', as: 'app' },
    ])
  })

  test('an app named in the id is the only one asked', async () => {
    state.byApp = { default: 'app', sales: 'other' }
    await expect(editInConversation('worker-session', 'slack:sales:C9', '8.000001', 'x')).rejects.toThrow(/was written by neither .+'s bot nor the operator/)
    expect(reads.map(r => r.app)).toEqual(['sales'])
    expect(calls).toEqual([])
  })

  test('anyone else’s message is refused before Slack is asked to touch it', async () => {
    state.author = 'other'
    await expect(editInConversation('worker-session', 'slack:C9', '8.000001', 'x')).rejects.toThrow("was written by neither any hydra app's bot nor the operator")
    await expect(deleteInConversation('main', 'slack:C9', '8.000001')).rejects.toThrow('is not hydra\'s to delete')
    expect(calls).toEqual([])
  })

  test('a message no app can read is Slack’s refusal, shown as it came', async () => {
    slackRuntimeDeps.author = async () => { throw new Error('An API error occurred: channel_not_found') }
    await expect(editInConversation('worker-session', 'slack:C9', '8.000001', 'x')).rejects.toThrow('channel_not_found')
  })
})

describe('the tools reach it: edit_message and delete_message with a Slack conversation as chat_id', () => {
  test('a session’s call is answered by the connector, not the chat gateway', async () => {
    const e = await executeTool('edit_message', { chat_id: 'slack:C1:6.000001', message_id: '8.000001', text: 'v2' }, 'crm-session')
    const d = await executeTool('delete_message', { chat_id: 'slack:C1:6.000001', message_id: '8.000001' }, 'crm-session')
    expect([e.content[0].text, d.content[0].text]).toEqual(['edited 8.000001 in slack:C1:6.000001', 'deleted 8.000001 in slack:C1:6.000001'])
    expect(calls.map(c => [c.verb, c.as])).toEqual([['edit', 'app'], ['delete', 'app']])
  })

  test('main’s call on the operator’s message uses the operator’s token; a session’s is refused', async () => {
    state.author = 'operator'
    await executeTool('edit_message', { chat_id: 'slack:C1:7.000001', message_id: '8.000001', text: 'v2' }, 'main')
    expect(calls.map(c => [c.verb, c.as])).toEqual([['edit', 'operator']])
    const refused = await executeTool('delete_message', { chat_id: 'slack:C1:6.000001', message_id: '8.000001' }, 'crm-session')
    expect(refused.isError).toBe(true)
    expect(refused.content[0].text).toContain('a restricted specialist may delete only its own app')
    expect(calls).toHaveLength(1)
  })
})
