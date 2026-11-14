// A scoped session's kept tools work in a Slack conversation bound to its specialist, and nowhere else in Slack: its home
// channel is not its conversation.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { join } from 'path'
import { STATE_DIR } from '../../../daemon/config.js'
import { registry } from '../../../daemon/sessions.js'
import { setSpecialistThread, _reloadSpecialists } from '../../../specialists/specialists.js'
import { _setHydraConfigForTesting } from '../../../daemon/hydra-config.js'
import { scopedRefusal } from '../../../daemon/bridge-dispatch.js'
import { conversationBelongsTo, getSlackWatcher, slackRuntimeDeps, stopSlackListener } from '../runtime.js'
import { TOP_LEVEL } from '../conversation.js'
import { TWO_APPS, hydra, view } from './slack-config.js'

process.stderr.write = (() => true) as any

const CRM = 'crm-t'
const OPS = 'ops-t'
const TOML = `${TWO_APPS}
[specialists.${CRM}]
workdir = "/w/crm"
listens = ["slack:C1"]
allow = ["anyone"]
home = "slack:C9"
[specialists.${OPS}]
workdir = "/w/ops"
listens = ["slack:C2"]
allow = ["anyone"]
home = "slack:C8"
`
const KEPT: [string, string][] = [['reply', 'chat_id'], ['react', 'chat_id'], ['edit_message', 'chat_id'], ['delete_message', 'chat_id'], ['download_attachment', 'chat_id'], ['fetch_messages', 'channel']]
const ids: string[] = []
const session = (id: string, threadId: string) => { ids.push(id); registry.set(id, { sessionId: id, tmuxName: id, threadId, sessionType: 'scoped', engine: 'claude', createdAt: Date.now() } as any) }

beforeEach(() => {
  _setHydraConfigForTesting(hydra(TOML))
  const v = view(TOML, { maxWatches: 5 })
  slackRuntimeDeps.view = () => v
  setSpecialistThread(CRM, 'crm-thread'); setSpecialistThread(OPS, 'ops-thread')
  session('crm-session', 'crm-thread'); session('ops-session', 'ops-thread')
})
afterEach(() => {
  for (const e of getSlackWatcher().list()) getSlackWatcher().unwatch(e.channel, e.threadTs, e.app)
  for (const s of ids.splice(0)) registry.delete(s)
  _setHydraConfigForTesting(undefined)
  rmSync(join(STATE_DIR, 'specialist-threads.json'), { force: true }); _reloadSpecialists()
  slackRuntimeDeps.view = () => null
  rmSync(join(STATE_DIR, 'slack-watches.json'), { force: true })
  stopSlackListener()
})

describe('a Slack conversation bound to the specialist', () => {
  test.each(KEPT)('%s passes the scope check there', (tool, key) => {
    getSlackWatcher().bind('C1', '5.000001', CRM, 'tool')
    expect(conversationBelongsTo('crm-session', 'slack:C1:5.000001')).toBe(true)
    expect(scopedRefusal('crm-session', tool, { [key]: 'slack:C1:5.000001', text: 'x' })).toBeUndefined()
  })
  test.each(KEPT)('%s is refused in a conversation bound to another specialist, and in one bound to no one', (tool, key) => {
    getSlackWatcher().bind('C2', '6.000001', OPS, 'tool')
    for (const other of ['slack:C2:6.000001', 'slack:C1:7.000001']) {
      expect(conversationBelongsTo('crm-session', other)).toBe(false)
      expect(scopedRefusal('crm-session', tool, { [key]: other, text: 'x' })).toBe(`${tool}: ${key} ${other} is not this session's own conversation; a scoped session acts only in its own thread or in a Slack conversation bound to its specialist`)
    }
  })
})

describe("the specialist's home is not its conversation", () => {
  // Every spelling reply accepts for a home: the configured value, the channel, and the channel's top level.
  const HOME = ['slack:C9', 'slack:C9:' + TOP_LEVEL, 'C9']
  test.each(HOME)('conversationBelongsTo(%s) is false', home => {
    expect(conversationBelongsTo('crm-session', home)).toBe(false)
  })
  for (const [tool, key] of KEPT) {
    test.each(HOME)(`${tool} on home %s is refused`, home => {
      expect(scopedRefusal('crm-session', tool, { [key]: home, text: 'x' })).toBe(`${tool}: ${key} ${home} is not this session's own conversation; a scoped session acts only in its own thread or in a Slack conversation bound to its specialist`)
    })
  }
  test('even with the home open as a conversation bound to the specialist (a post to it opens one)', () => {
    getSlackWatcher().bind('C9', '8.000001', CRM, 'home')
    // That thread IS bound to the specialist, so it is its conversation: the refusal is for the channel itself.
    expect(conversationBelongsTo('crm-session', 'slack:C9:8.000001')).toBe(true)
    expect(conversationBelongsTo('crm-session', 'slack:C9')).toBe(false)
  })
})
