import { beforeEach, expect, test } from 'bun:test'
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { OmpEngine } from '../engines/omp-engine.js'
import { ompSessionDir } from '../engines/omp-session.js'

// omp's own session file. The fixture is a real one from `omp --session-dir` (user asked for `echo hi` then DONE): user message at
// 1791874541262, assistant toolUse at ...309, toolResult at ...125, final assistant `stop` "DONE" at 1791874543153, usage input 2 / cacheRead 13713 / cacheWrite 84.
const fixture = join(import.meta.dir, 'fixtures', 'omp-session.jsonl')
const FINAL_AT = 1791874543153
const engine = new OmpEngine({} as any)
const info = { sessionId: 'omp-session-t1', tmuxName: 'omp-session-t1', sessionMetadata: { model: 'claude-sonnet-5-5[1m]' } } as any
const file = () => join(ompSessionDir(info.sessionId), '2026-10-13T00-00-00-000Z_x.jsonl')

beforeEach(() => {
  rmSync(ompSessionDir(info.sessionId), { recursive: true, force: true })
  mkdirSync(ompSessionDir(info.sessionId), { recursive: true })
  copyFileSync(fixture, file())
})

test('a final assistant message at or after the pending message is a complete turn with its text', () => {
  expect(engine.turn(info, FINAL_AT).confirmedComplete).toBe(true)
  expect(engine.turn(info, FINAL_AT).answer()).toBe('DONE')
})

test('an answer from before the pending message is not complete and is never relayed', () => {
  expect(engine.turn(info, FINAL_AT + 1).confirmedComplete).toBe(false)
  expect(engine.turn(info, FINAL_AT + 1).answer()).toBeNull()
})

test('while the assistant is still calling tools the turn is not complete', () => {
  const lines = readFileSync(fixture, 'utf8').trim().split('\n')
  writeFileSync(file(), lines.slice(0, -1).join('\n') + '\n') // ends at the tool result
  expect(engine.turn(info, 0).confirmedComplete).toBe(false)
  writeFileSync(file(), lines.slice(0, -2).join('\n') + '\n') // ends at the assistant's tool call
  expect(engine.turn(info, 0).confirmedComplete).toBe(false)
})

test('a new user message after the answer starts a new turn', () => {
  appendFileSync(file(), JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'again' }], timestamp: FINAL_AT + 5 } }) + '\n')
  expect(engine.turn(info, 0).confirmedComplete).toBe(false)
})

test('no session file yet is not complete and has no context size', () => {
  rmSync(ompSessionDir(info.sessionId), { recursive: true, force: true })
  expect(engine.turn(info, 0).confirmedComplete).toBe(false)
  expect(engine.usage(info)).toBeNull()
})

test('a line omp is still writing is skipped, not an error', () => {
  appendFileSync(file(), '{"type":"message","message":{"role":"assistant","stopRea')
  expect(engine.turn(info, FINAL_AT).answer()).toBe('DONE')
})

test('a final message longer than the tail window reads as not complete', () => {
  const huge = JSON.stringify({ type: 'message', message: { role: 'assistant', stopReason: 'stop', timestamp: FINAL_AT + 10, content: [{ type: 'text', text: 'x'.repeat(300 * 1024) }] } })
  appendFileSync(file(), huge + '\n')
  expect(engine.turn(info, 0).confirmedComplete).toBe(false)
})

test('context is the last request\'s input plus both cache counters over the launch window', () => {
  const used = 2 + 13713 + 84
  expect(engine.usage(info)).toEqual({ usedTokens: used, contextWindow: 1_000_000, percent: Math.round(used * 100 / 1_000_000) })
  expect(engine.usage({ ...info, sessionMetadata: { model: 'no-such-model' } })).toBeNull()
})

// Spend (Raindrop). Sums of the fixture's two assistant messages (usage input/output/cacheWrite/cacheRead): 4/74/13713/0 and 2/5/84/13713.
const FIXTURE_TOTALS = { inputTokens: 6, outputTokens: 79, cacheCreateTokens: 13797, cacheReadTokens: 13713 }
const assistantLine = (usage: object) => JSON.stringify({ type: 'message', message: { role: 'assistant', stopReason: 'stop', timestamp: FINAL_AT + 100, usage } }) + '\n'

test('usage totals sum every assistant message and name the omp session', () => {
  const r = engine.usageTotals(info, undefined)!
  expect(r.totals).toEqual(FIXTURE_TOTALS)
  expect(r.providerSessionId).toBe('01a1340b-a56a-7258-8f7e-a382e0cfcf7b')
  expect(r.restarted).toBe(false)
})

test('a second read adds only what omp appended since', () => {
  const first = engine.usageTotals(info, undefined)!
  const same = engine.usageTotals(info, first.cursor)!
  expect(same.totals).toEqual(FIXTURE_TOTALS)
  expect(same.restarted).toBe(false)
  appendFileSync(file(), assistantLine({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }))
  const next = engine.usageTotals(info, first.cursor)!
  expect(next.totals).toEqual({ inputTokens: 7, outputTokens: 81, cacheCreateTokens: 13801, cacheReadTokens: 13716 })
  expect(next.providerSessionId).toBe('01a1340b-a56a-7258-8f7e-a382e0cfcf7b')
})

test('a line omp is still writing is counted once it is complete, not before', () => {
  const first = engine.usageTotals(info, undefined)!
  const line = assistantLine({ input: 1, output: 1, cacheRead: 1, cacheWrite: 1 })
  appendFileSync(file(), line.slice(0, 40))
  const partial = engine.usageTotals(info, first.cursor)!
  expect(partial.totals).toEqual(FIXTURE_TOTALS)
  appendFileSync(file(), line.slice(40))
  expect(engine.usageTotals(info, partial.cursor)!.totals).toEqual({ inputTokens: 7, outputTokens: 80, cacheCreateTokens: 13798, cacheReadTokens: 13714 })
})

test('a session file that got shorter starts the totals over', () => {
  const first = engine.usageTotals(info, undefined)!
  writeFileSync(file(), assistantLine({ input: 5, output: 5, cacheRead: 5, cacheWrite: 5 }))
  expect(statSync(file()).size).toBeLessThan((first.cursor as { offset: number }).offset)
  const r = engine.usageTotals(info, first.cursor)!
  expect(r.restarted).toBe(true)
  expect(r.totals).toEqual({ inputTokens: 5, outputTokens: 5, cacheCreateTokens: 5, cacheReadTokens: 5 })
})

test('a replaced session file, even a longer one, starts the totals over under its own id', () => {
  const first = engine.usageTotals(info, undefined)!
  const other = readFileSync(fixture, 'utf8').replace('01a1340b-a56a-7258-8f7e-a382e0cfcf7b', 'other-session') + assistantLine({ input: 1, output: 1, cacheRead: 1, cacheWrite: 1 })
  writeFileSync(file(), other)
  expect(statSync(file()).size).toBeGreaterThan((first.cursor as { offset: number }).offset)
  const r = engine.usageTotals(info, first.cursor)!
  expect(r.restarted).toBe(true)
  expect(r.providerSessionId).toBe('other-session')
  expect(r.totals).toEqual({ inputTokens: 7, outputTokens: 80, cacheCreateTokens: 13798, cacheReadTokens: 13714 })
})

test('a message that is not the assistant\'s is not counted, even with a usage field', () => {
  appendFileSync(file(), JSON.stringify({ type: 'message', message: { role: 'user', usage: { input: 9, output: 9, cacheRead: 9, cacheWrite: 9 } } }) + '\n')
  expect(engine.usageTotals(info, undefined)!.totals).toEqual(FIXTURE_TOTALS)
})

test('a line longer than the read cap is skipped, and the spend after it is still counted', () => {
  const giant = JSON.stringify({ type: 'message', message: { role: 'toolResult', content: [{ type: 'text', text: 'x'.repeat(9 * 1024 * 1024) }] } }) + '\n'
  appendFileSync(file(), giant + assistantLine({ input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }))
  let r = engine.usageTotals(info, undefined)!
  for (let i = 0; i < 4; i++) r = engine.usageTotals(info, r.cursor)!
  expect(r.totals).toEqual({ inputTokens: 7, outputTokens: 80, cacheCreateTokens: 13798, cacheReadTokens: 13714 })
})

test('no session file yet has no usage', () => {
  rmSync(ompSessionDir(info.sessionId), { recursive: true, force: true })
  expect(engine.usageTotals(info, undefined)).toBeNull()
})
