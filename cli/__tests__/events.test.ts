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
