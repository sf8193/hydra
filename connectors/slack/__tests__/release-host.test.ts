import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SlackWatcher, type SlackMessageEvent } from '../watch.js'
import { oneListener, view } from './slack-config.js'

const CH = 'C0FOOD'
const SESSION = '1552619225032425525'
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function setup(hosted: () => boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'slack-release-host-'))
  dirs.push(dir)
  const alerts: string[] = []
  const sent: string[] = []
  const w = new SlackWatcher({
    now: () => 1_000_000_000_000, file: join(dir, 'w.json'), log: () => {}, config: () => view(oneListener(CH)), alert: t => { alerts.push(t) }, hosted,
    deliver: async ({ to }) => { sent.push(to); return { ok: true } },
  })
  return { w, alerts, sent }
}
const ev = (o: Partial<SlackMessageEvent>): SlackMessageEvent => ({ channel: 'C0OTHER', ts: '1000.000001', user: 'UALICE', text: 'hi', ...o })

test('two deliveries queued for a released binding tell its session once and deliver nothing', async () => {
  const { w, alerts, sent } = setup(() => true)
  w.bind('C0OTHER', '2000.000001', SESSION, 'tool')
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
  const { w, alerts } = setup(() => true)
  w.bind('C0OTHER', '2000.000001', SESSION, 'tool')
  w.handle(ev({ ts: '2001.000001', threadTs: '2000.000001' }))
  const a = w.flush()
  w.unwatch('C0OTHER', '2000.000001')
  w.bind('C0OTHER', '2000.000001', 'helper', 'cli')
  await a
  expect(w.get('C0OTHER', '2000.000001')?.specialist).toBe('helper')
  expect(alerts.filter(t => t.includes("is now a hydra session's own thread"))).toEqual([])
})
