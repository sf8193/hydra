import { beforeEach, expect, test } from 'bun:test'
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
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
