import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ConversationTable, type SlackMessageEvent } from '../watch.js'
import { BOT, oneListener, view } from './slack-config.js'
import { LANDED } from './outcomes.js'

const CH = 'C0FOOD'
const SESSION = '1552619225032425525'
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function setup(initially: boolean) {
  const host = { is: initially }
  const hosted = () => host.is
  const dir = mkdtempSync(join(tmpdir(), 'slack-release-host-'))
  dirs.push(dir)
  const alerts: string[] = []
  const sent: string[] = []
  const logs: string[] = []
  const w = new ConversationTable({
    now: () => 1_000_000_000_000, file: join(dir, 'w.json'), log: l => { logs.push(l) }, config: () => view(oneListener(CH)), alert: t => { alerts.push(t) }, hosted,
    deliver: async ({ to }) => { sent.push(to); return LANDED },
  })
  return { w, alerts, sent, logs, host }
}
const ev = (o: Partial<SlackMessageEvent>): SlackMessageEvent => ({ channel: 'C0OTHER', ts: '1000.000001', user: 'UALICE', text: 'hi', ...o })

test('two deliveries queued for a released binding tell its session once and deliver nothing', async () => {
  const { w, alerts, sent, host } = setup(false)
  w.bind('C0OTHER', '2000.000001', SESSION, 'tool')
  host.is = true   // a session has since started in the thread
  w.handle(ev({ ts: '2001.000001', threadTs: '2000.000001' }))
  const a = w.flush()
  w.handle(ev({ ts: '2002.000001', threadTs: '2000.000001' }))
  const b = w.flush()
  await a; await b
  expect(alerts.filter(t => t.includes("is now a hydra session's own thread"))).toHaveLength(1)
  expect(sent).toEqual([])
  expect(w.get('C0OTHER', '2000.000001')).toBeUndefined()
})

test('a delivery queued before its binding was replaced leaves the new binding alone', async () => {
  const { w, alerts, host } = setup(false)
  w.bind('C0OTHER', '2000.000001', SESSION, 'tool')
  host.is = true
  w.handle(ev({ ts: '2001.000001', threadTs: '2000.000001' }))
  const a = w.flush()
  w.unwatch('C0OTHER', '2000.000001')
  host.is = false
  w.bind('C0OTHER', '2000.000001', 'helper', 'cli')
  await a
  expect(w.get('C0OTHER', '2000.000001')?.specialist).toBe('helper')
  expect(alerts.filter(t => t.includes("is now a hydra session's own thread"))).toEqual([])
})

const tagged = (o: Partial<SlackMessageEvent>) => ev({ channel: CH, text: `<@${BOT}> hi`, ...o })

test("a tag in a hydra session's own thread opens no conversation and is not blamed on a full table", async () => {
  const { w, sent, logs } = setup(true)
  w.handle(tagged({ ts: '2001.000001', threadTs: '2000.000001' }))
  await w.flush()
  expect(w.get(CH, '2000.000001')).toBeUndefined()
  expect(sent).toEqual([])
  expect(logs.join('')).not.toContain('table is full')
  expect(w.bind(CH, '2000.000001', 'helper', 'cli')).toBeUndefined()
})

test("the same tag in a thread that is no session's own opens one", async () => {
  const { w, sent } = setup(false)
  w.handle(tagged({ ts: '2001.000001', threadTs: '2000.000001' }))
  await w.flush()
  expect(w.get(CH, '2000.000001')?.specialist).toBe('helper')
  expect(sent).toEqual(['helper'])
})

test("the bot's own post in a hydra session's own thread opens no conversation", () => {
  const { w, logs } = setup(true)
  w.handle(ev({ channel: CH, user: BOT, ts: '2000.000001' }))
  expect(w.get(CH, '2000.000001')).toBeUndefined()
  expect(logs.join('')).not.toContain('table is full')
})

test("a tag in a thread a session was listening to, and a session has since started in, lets the listener go and binds nothing", async () => {
  const { w, alerts, sent, host } = setup(false)
  w.bind(CH, '2000.000001', SESSION, 'tool')
  host.is = true
  w.handle(tagged({ ts: '2001.000001', threadTs: '2000.000001' }))
  await w.flush()
  expect(w.get(CH, '2000.000001')).toBeUndefined()
  expect(sent).toEqual([])
  expect(alerts.filter(t => t.includes("is now a hydra session's own thread"))).toHaveLength(1)
})
