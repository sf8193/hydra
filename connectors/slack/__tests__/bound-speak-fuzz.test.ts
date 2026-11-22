// Differential fuzz: the ownership rule (ownConversationRefusal, which reply and the restricted layer go through) against a frozen copy of the
// rule before a plain session could speak in a thread bound to its own thread, on every (session kind × binding × app × tagged × use × shape)
// case. They must agree on every case but one class: a plain session using a conversation bound to its own thread, which it now may.
import { describe, test, expect, afterAll, beforeAll } from 'bun:test'
import { rmSync } from 'fs'
import { join } from 'path'
import { STATE_DIR } from '../../../infra/config.js'
import { registry } from '../../../sessions/registry.js'
import { _setHydraConfigForTesting } from '../../../infra/hydra-config.js'
import { noteDeclaredRestrictions } from '../../../sessions/tool-surface.js'
import { setSpecialistThread } from '../../../sessions/specialists.js'
import { getConversationTable, ownConversationRefusal, slackRuntimeDeps, type OwnUse } from '../runtime.js'
import { ownConversationRefusal as beforeRefusal } from './fixtures/own-conversation-before-bound-speak.js'
import { TOP_LEVEL } from '../watch.js'
import { conversationSessionName } from '../../../app/targets.js'
import { TWO_APPS, hydra, view } from './slack-config.js'
import * as slackTargets from '../../../app/targets.js'
import { bindSlackDelivery } from '../runtime.js'
bindSlackDelivery(slackTargets)

process.stderr.write = (() => true) as any

const TOML = `${TWO_APPS}
[people.alice]
addresses = ["slack:UALICE"]
[specialists.food]
workdir = "/w/food"
reachable_by = ["role:anyone"]
[[rules]]
place = "slack:C0FOOD"
target = "specialist:food"
[specialists.deals]
workdir = "/w/deals"
pinned_to = ["app:sales"]
reachable_by = ["role:anyone"]
[[rules]]
place = "slack:C0DEAL"
target = "specialist:deals"
[specialists.desk]
workdir = "/w/desk"
sessions = "per-conversation"
reachable_by = ["role:anyone"]
[[rules]]
place = "slack:C0DESK"
target = "specialist:desk"
[specialists.vault]
workdir = "/w/vault"
restricted = true
reachable_by = ["role:anyone"]
[[rules]]
place = "slack:C0VAULT"
target = "specialist:vault"
`

// Session kinds: [caller id, its thread, its record (undefined: none), declared restricted by its bridge]. Each `t-*` thread is a session thread id.
const T = { plain: '1000000000000000001', other: '1000000000000000002', restricted: '1000000000000000003', confined: '1000000000000000004', declared: '1000000000000000005', declaredConfined: '1000000000000000006' }
/** `conversationOf`: a per-conversation specialist's session for the case's own conversation (its name is that conversation's). */
type Kind = { id: string; thread?: string; record?: Record<string, unknown>; declare?: { restricted?: boolean; writeConfined?: boolean }; plainIn?: string; conversationOf?: string }
const KINDS: Kind[] = [
  { id: 'main' },
  { id: 'fz-plain', thread: T.plain, record: {}, plainIn: T.plain },
  { id: 'fz-other', thread: T.other, record: {}, plainIn: T.other },
  { id: 'fz-guest', thread: T.plain, record: { sessionType: 'thread_guest' } },
  { id: 'fz-food', thread: 'food-thread', record: {} },
  { id: 'fz-deals', thread: 'deals-thread', record: {} },
  { id: 'fz-desk-conv', thread: 'desk-conv-thread', conversationOf: 'desk' },
  { id: 'fz-vault', thread: 'vault-thread', record: { policy: { restricted: true } } },
  { id: 'fz-restricted', thread: T.restricted, record: { policy: { restricted: true } } },
  { id: 'fz-confined', thread: T.confined, record: { policy: { restricted: false, canOnlyWriteTo: ['/tmp/x'] } } },
  { id: 'fz-declared', thread: T.declared, record: {}, declare: { restricted: true } },
  { id: 'fz-declared-confined', thread: T.declaredConfined, record: {}, declare: { writeConfined: true } },
  { id: 'fz-ghost' },
]
// What the conversation is bound to; undefined: no conversation is open there.
const BINDINGS: (string | undefined)[] = ['food', 'deals', 'desk', 'vault', 'main', ...Object.values(T), undefined]
const APPS = ['default', 'sales']
const TAGGED = [true, false]
const USES: OwnUse[] = ['a reply', 'a read', 'an edit', 'a delete', 'a reaction', 'a download']
const SHAPES = [{ channel: 'C0ELSE', threadTs: '1700000000.000100' }, { channel: 'D0DM00001', threadTs: TOP_LEVEL }]

const conversation = (app: string, s: { channel: string; threadTs: string }) =>
  `slack:${app === 'default' ? '' : `${app}:`}${s.channel}${s.threadTs === TOP_LEVEL ? '' : `:${s.threadTs}`}`

describe('who may use a Slack conversation: the rule against its parent', () => {
  const realView = slackRuntimeDeps.view
  beforeAll(() => {
    _setHydraConfigForTesting(hydra(TOML))
    const v = view(TOML)
    slackRuntimeDeps.view = () => v
    setSpecialistThread('food', 'food-thread'); setSpecialistThread('deals', 'deals-thread'); setSpecialistThread('vault', 'vault-thread')
    for (const k of KINDS) {
      if (k.record) registry.set(k.id, { sessionId: k.id, tmuxName: k.id, threadId: k.thread, sessionType: 'thread_owner', engine: 'claude', createdAt: Date.now(), ...k.record } as any)
      if (k.declare) noteDeclaredRestrictions(k.id, k.declare)
    }
  })
  afterAll(() => {
    for (const e of getConversationTable().list()) getConversationTable().unwatch(e.channel, e.threadTs, e.app)
    for (const k of KINDS) registry.delete(k.id)
    slackRuntimeDeps.view = realView
    _setHydraConfigForTesting(undefined)
    rmSync(join(STATE_DIR, 'slack-watches.json'), { force: true })
  })

  test('they differ only where a plain session uses a conversation bound to its own thread: now allowed, before refused', () => {
    const counts = { cases: 0, agree: 0, differ: 0, differPlainOwn: 0, allowedBoth: 0, refusedBoth: 0 }
    const unexpected: string[] = []
    for (const k of KINDS) for (const bound of BINDINGS) for (const app of APPS) for (const tagged of TAGGED) for (const use of USES) for (const shape of SHAPES) {
      // `tagged` is a fact on the delivery, never an input to who may speak (the session judges): the rule does not read it, so it doubles the cases and changes none.
      void tagged
      const table = getConversationTable()
      for (const e of table.list()) table.unwatch(e.channel, e.threadTs, e.app)
      if (bound) table.bind(shape.channel, shape.threadTs, bound, 'cli', app)
      const id = conversation(app, shape)
      if (k.conversationOf) registry.set(k.id, { sessionId: k.id, tmuxName: conversationSessionName(k.conversationOf, id), threadId: k.thread, sessionType: 'thread_owner', engine: 'claude', createdAt: Date.now() } as any)
      const now = ownConversationRefusal(k.id, id, use)
      const before = beforeRefusal(k.id, id, use)
      counts.cases++
      const expectDiffer = !!bound && k.plainIn === bound
      if ((now === undefined) === (before === undefined)) {
        counts.agree++
        if (now === undefined) counts.allowedBoth++; else counts.refusedBoth++
        if (expectDiffer) unexpected.push(`agree but should differ: ${k.id} ${bound} ${id} ${use}`)
      } else {
        counts.differ++
        if (expectDiffer && now === undefined && before !== undefined) counts.differPlainOwn++
        else unexpected.push(`differ: ${k.id} → ${bound} ${id} ${use}: now ${now ?? 'allowed'}; before ${before ?? 'allowed'}`)
      }
    }
    process.stdout.write(`bound-speak fuzz: ${JSON.stringify(counts)}\n`)
    expect(unexpected).toEqual([])
    expect(counts.differ).toBe(counts.differPlainOwn)
    // 2 plain kinds × their own binding × 2 apps × 2 tagged × 6 uses × 2 shapes.
    expect(counts.differPlainOwn).toBe(2 * 2 * 2 * 6 * 2)
    expect(counts.cases).toBe(KINDS.length * BINDINGS.length * APPS.length * TAGGED.length * USES.length * SHAPES.length)
  })
})
