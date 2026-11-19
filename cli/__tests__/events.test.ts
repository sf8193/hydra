// `hydra events`: reads the day files, filters by kind, age and conversation, prints a table or one JSON event per line.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { eventsDir, eventLine, dayOf } from '../../shared/events.js'
import { eventsCommand, readEvents } from '../events.js'

const NOW = Date.now()
const HOUR = 3_600_000
let dir: string
const put = (ms: number, e: Parameters<typeof eventLine>[0]) => {
  mkdirSync(eventsDir(dir), { recursive: true })
  writeFileSync(join(eventsDir(dir), `${dayOf(ms)}.jsonl`), eventLine(e, ms) + '\n', { flag: 'a' })
}
const endTornLine = () => writeFileSync(join(eventsDir(dir), `${dayOf(NOW)}.jsonl`), '\n', { flag: 'a' })   // setup leaves a half-written line: end it before adding more
const A = 'slack:C0A:1.000001'
const B = 'slack:C0B:2.000001'

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hydra-events-'))
  put(NOW - 50 * HOUR, { kind: 'route', app: 'default', conversation: A, by: 'slack:U1', tagged: true, via: 'router', to: 'slack-router' })
  put(NOW - 30 * HOUR, { kind: 'bind', conversation: A, from: 'slack-router', to: 'desk', why: 'ledger work', by: 'slack-router' })
  put(NOW - 2 * HOUR, { kind: 'route', app: 'default', conversation: B, by: 'slack:U2', tagged: true, via: 'none' })
  put(NOW - 1 * HOUR, { kind: 'unbind', conversation: B, from: 'desk', by: 'operator' })
  writeFileSync(join(eventsDir(dir), `${dayOf(NOW)}.jsonl`), 'a torn li', { flag: 'a' })   // a half-written line is skipped
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const out = (args: string[], json = false) => {
  const lines: string[] = []
  const real = console.log
  console.log = (s: string) => { lines.push(s) }
  try { return { code: eventsCommand(args, dir, json), lines } } finally { console.log = real }
}

describe('hydra events', () => {
  test('oldest first, across day files', () => {
    expect(readEvents(dir, {}).map(e => e.kind)).toEqual(['route', 'bind', 'route', 'unbind'])
  })
  test('--kind, --since and --conversation each narrow it, and combine', () => {
    expect(readEvents(dir, { kind: 'route' })).toHaveLength(2)
    expect(readEvents(dir, { sinceMs: NOW - 3 * HOUR }).map(e => e.kind)).toEqual(['route', 'unbind'])
    expect(readEvents(dir, { conversation: A }).map(e => e.kind)).toEqual(['route', 'bind'])
    expect(readEvents(dir, { conversation: A, kind: 'bind' })).toHaveLength(1)
  })
  test('--limit keeps the newest N, still oldest first, after the other filters', () => {
    expect(readEvents(dir, { limit: 2 }).map(e => e.kind)).toEqual(['route', 'unbind'])
    expect(readEvents(dir, { limit: 99 })).toHaveLength(4)
    expect(readEvents(dir, { kind: 'route', limit: 1 }).map(e => e.conversation)).toEqual([B])
    expect(readEvents(dir, { conversation: A, limit: 1 }).map(e => e.kind)).toEqual(['bind'])
    expect(readEvents(dir, { sinceMs: NOW - 40 * HOUR, limit: 2 }).map(e => e.kind)).toEqual(['route', 'unbind'])
    expect(readEvents(dir, { sinceMs: NOW - 40 * HOUR, limit: 3 }).map(e => e.kind)).toEqual(['bind', 'route', 'unbind'])
    expect(out(['--limit', '1'], true).lines.map(l => JSON.parse(l).kind)).toEqual(['unbind'])
    expect(out(['--limit', '2']).lines).toHaveLength(2)
  })
  test('--limit must be a positive whole number', () => {
    const real = console.error
    const errs: string[] = []
    console.error = (s: string) => { errs.push(s) }
    try {
      for (const bad of ['0', '-1', '2.5', 'ten', '']) expect(eventsCommand(['--limit', bad], dir, false)).toBe(1)
      expect(eventsCommand(['--limit'], dir, false)).toBe(1)
    } finally { console.error = real }
    expect(errs.every(e => e.includes('--limit'))).toBe(true)
  })
  test('--to keeps the routes and binds that went to one place; an unbind has none', () => {
    expect(readEvents(dir, { to: 'desk' }).map(e => e.kind)).toEqual(['bind'])
    expect(readEvents(dir, { to: 'slack-router' }).map(e => e.kind)).toEqual(['route'])
    expect(readEvents(dir, { to: 'des' })).toEqual([])
    expect(out(['--to', 'desk', '--kind', 'bind'], true).lines).toHaveLength(1)
  })
  test("--conversation finds a conversation through any app, however it is spelled: with no app, the id matches every app's; with one, only that app's", () => {
    const C = 'slack:sales:C0C:3.000001'
    endTornLine()
    put(NOW - 30 * 60_000, { kind: 'route', app: 'sales', conversation: C, by: 'slack:U3', tagged: true, via: 'rule', to: 'deals' })
    expect(readEvents(dir, { conversation: 'slack:C0C:3.000001' }).map(e => e.conversation)).toEqual([C])
    expect(readEvents(dir, { conversation: C }).map(e => e.conversation)).toEqual([C])
    expect(readEvents(dir, { conversation: 'slack:other:C0C:3.000001' })).toEqual([])
    // the app `default` is spelled with none, and either way names it
    expect(readEvents(dir, { conversation: 'slack:default:C0A:1.000001' }).map(e => e.kind)).toEqual(['route', 'bind'])
    expect(readEvents(dir, { conversation: 'slack:sales:C0A:1.000001' })).toEqual([])
  })
  test('a reason shows beside who: hydra letting one go itself, or moving its binding', () => {
    endTornLine()
    put(NOW - 10 * 60_000, { kind: 'unbind', conversation: A, from: 'desk', by: 'hydra', reason: 'evicted' })
    expect(out(['--by', 'hydra']).lines[0]).toContain('by hydra (evicted)')
    expect(readEvents(dir, { by: 'hydra' }).map(e => e.kind === 'unbind' && e.reason)).toEqual(['evicted'])
  })
  test('--by keeps exactly the events that actor made', () => {
    expect(readEvents(dir, { by: 'slack-router' }).map(e => e.kind)).toEqual(['bind'])
    expect(readEvents(dir, { by: 'slack:U2' }).map(e => e.kind)).toEqual(['route'])
    expect(readEvents(dir, { by: 'operator' }).map(e => e.kind)).toEqual(['unbind'])
    expect(readEvents(dir, { by: 'slack' })).toEqual([])
    expect(readEvents(dir, { by: 'slack-router', kind: 'route' })).toEqual([])
    expect(out(['--by', 'slack:U1'], true).lines.map(l => JSON.parse(l).via)).toEqual(['router'])
  })
  test('--json prints one event per line', () => {
    const { code, lines } = out(['--kind', 'bind'], true)
    expect(code).toBe(0)
    expect(lines.map(l => JSON.parse(l))).toMatchObject([{ kind: 'bind', to: 'desk', why: 'ledger work' }])
  })
  test('the table names time, kind, conversation and what happened', () => {
    const { lines } = out(['--since', '3h'])
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\dZ {2}route {3}slack:C0B:2\.000001 {2}none · default · by slack:U2 · tagged$/)
    expect(lines[1]).toContain('unbind')
  })
  test('nothing found says so; a bad flag or duration is a usage error', () => {
    expect(out(['--conversation', 'slack:C0Z:9.000001']).lines).toEqual(['no events'])
    const real = console.error
    const errs: string[] = []
    console.error = (s: string) => { errs.push(s) }
    try {
      expect(eventsCommand(['--kind', 'session'], dir, false)).toBe(1)
      expect(eventsCommand(['--since', 'soon'], dir, false)).toBe(1)
      expect(eventsCommand(['--bogus'], dir, false)).toBe(1)
    } finally { console.error = real }
    expect(errs[0]).toContain('kinds: route, bind, unbind')
  })
  test('no events folder is no events', () => {
    rmSync(eventsDir(dir), { recursive: true })
    expect(readEvents(dir, {})).toEqual([])
  })
})
