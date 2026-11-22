// The event stream's writer: one line per event in the UTC day's file, ids and reasons only, a failed write swallowed, old day files pruned.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { STATE_DIR } from '../../infra/config.js'
import * as hydraConfig from '../hydra-config.js'
import { _setHydraConfigForTesting } from '../hydra-config.js'
import { _resetEventsForTesting, pruneEvents, recordEvent } from '../../infra/events.js'
import { eventsDir } from '../../shared/events.js'
import { EMPTY_CONFIG } from '../../config/load.js'

const DIR = eventsDir(STATE_DIR)
const DAY = 86_400_000
const NOW = Date.UTC(2026, 10, 18, 23, 59, 30)
const day = (n: number) => new Date(NOW - n * DAY).toISOString().slice(0, 10)
const names = () => (existsSync(DIR) ? readdirSync(DIR).sort() : [])
const keep = (days?: number) => _setHydraConfigForTesting({ ...EMPTY_CONFIG, ...(days && { events: { keepDays: days } }) })
const bind = { kind: 'bind', conversation: 'slack:C0A:1.000001', from: 'desk', to: 'main', why: 'fits', by: 'operator' } as const

beforeEach(() => { rmSync(DIR, { recursive: true, force: true }); _resetEventsForTesting(); keep() })
afterEach(() => { rmSync(DIR, { recursive: true, force: true }); _setHydraConfigForTesting(undefined) })

describe('writing', () => {
  test('one JSON line per event, appended to the UTC day file, with ts and kind first', () => {
    recordEvent(bind, NOW)
    recordEvent({ kind: 'unbind', conversation: 'slack:C0A:1.000001', from: 'main', by: 'operator' }, NOW + 60_000)   // past midnight UTC: the next day's file
    expect(names()).toEqual([`${day(0)}.jsonl`, `${day(-1)}.jsonl`])
    const lines = readFileSync(join(DIR, `${day(0)}.jsonl`), 'utf8').split('\n')
    expect(lines[1]).toBe('')
    expect(Object.keys(JSON.parse(lines[0]))).toEqual(['ts', 'kind', 'conversation', 'from', 'to', 'why', 'by'])
    expect(JSON.parse(lines[0])).toMatchObject({ ts: '2026-11-18T23:59:30.000Z', kind: 'bind', why: 'fits' })
  })

  test('no text reaches a line: a field the kind does not name is dropped, even one called text', () => {
    recordEvent({ ...bind, text: 'the launch code is hunter2', body: 'hunter2' } as any, NOW)
    recordEvent({ kind: 'route', app: 'default', conversation: 'slack:C0A:1.000001', tagged: true, via: 'none', text: 'hunter2' } as any, NOW)
    const raw = readFileSync(join(DIR, `${day(0)}.jsonl`), 'utf8')
    expect(raw).not.toContain('hunter2')
    expect(raw.trim().split('\n')).toHaveLength(2)
  })

  test('a failed write is swallowed and said once', () => {
    mkdirSync(join(DIR, '..'), { recursive: true })
    writeFileSync(DIR, 'a file where the folder should be')
    const err: string[] = []
    const real = process.stderr.write
    process.stderr.write = ((s: string) => { err.push(s); return true }) as any
    try {
      expect(() => { recordEvent(bind, NOW); recordEvent(bind, NOW); recordEvent(bind, NOW) }).not.toThrow()
    } finally { process.stderr.write = real; rmSync(DIR, { force: true }) }
    expect(err.filter(l => l.includes('event stream'))).toHaveLength(1)
  })
})

describe('retention: day files older than keep_days go, nothing else does', () => {
  const seed = () => {
    mkdirSync(DIR, { recursive: true })
    for (const n of [0, 1, 29, 30, 31, 90]) writeFileSync(join(DIR, `${day(n)}.jsonl`), '{}\n')
    writeFileSync(join(DIR, 'notes.txt'), 'not an event file')
    writeFileSync(join(DIR, `${day(90)}.jsonl.bak`), 'not a day file either')
  }

  test('the default keeps 30 days: the 31st and older are deleted, other files stay', () => {
    seed()
    pruneEvents(NOW)
    expect(names()).toEqual([`${day(90)}.jsonl.bak`, `${day(30)}.jsonl`, `${day(29)}.jsonl`, `${day(1)}.jsonl`, `${day(0)}.jsonl`, 'notes.txt'].sort())
  })

  test('[events] keep_days sets the line', () => {
    seed(); keep(2)
    pruneEvents(NOW)
    expect(names().filter(n => n.endsWith('.jsonl'))).toEqual([`${day(1)}.jsonl`, `${day(0)}.jsonl`].sort())
    expect(names()).toContain('notes.txt')
  })

  test('the day rolling over prunes on the first write of the new day, and not on later ones', () => {
    seed()
    recordEvent(bind, NOW)   // first write since the process began: a day "arrived"
    expect(names()).not.toContain(`${day(31)}.jsonl`)
    writeFileSync(join(DIR, `${day(60)}.jsonl`), '{}\n')
    recordEvent(bind, NOW + 1000)   // same day: no sweep
    expect(names()).toContain(`${day(60)}.jsonl`)
    recordEvent(bind, NOW + DAY)    // the day turned
    expect(names()).not.toContain(`${day(60)}.jsonl`)
  })

  test('nothing is deleted while hydra.toml has not loaded: keep_days is unknown', () => {
    seed()
    _setHydraConfigForTesting(undefined)
    writeFileSync(join(STATE_DIR, 'hydra.toml'), 'this is = = not toml')
    const err = process.stderr.write
    process.stderr.write = (() => true) as any
    try {
      hydraConfig.startHydraConfig({ alert: async () => true })
      expect(hydraConfig.hydraConfigLoadedOk()).toBe(false)
      pruneEvents(NOW)
      expect(names()).toContain(`${day(90)}.jsonl`)
    } finally { hydraConfig.stopHydraConfig(); process.stderr.write = err; rmSync(join(STATE_DIR, 'hydra.toml'), { force: true }) }
  })

  test('a clock stepped back writes into the old day and does not sweep', () => {
    recordEvent(bind, NOW)
    writeFileSync(join(DIR, `${day(60)}.jsonl`), '{}\n')
    recordEvent(bind, NOW - 2 * DAY)
    expect(names()).toContain(`${day(60)}.jsonl`)
    expect(names()).toContain(`${day(2)}.jsonl`)
  })

  test('a bind\'s why is one line, at most 300 characters', () => {
    recordEvent({ ...bind, why: `first\nsecond ${'x'.repeat(500)}` }, NOW)
    const e = JSON.parse(readFileSync(join(DIR, `${day(0)}.jsonl`), 'utf8'))
    expect(e.why.length).toBe(300)
    expect(e.why.startsWith('first second x')).toBe(true)
  })

  test('no events folder is not an error', () => { expect(() => pruneEvents(NOW)).not.toThrow() })
})
