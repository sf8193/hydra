import { afterAll, beforeEach, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { agyContextTokens, agyState, agyStateDir, agyStateFile, agyTurn, agyUsageTotals } from '../engines/agy-session.js'

// A transcript as agy writes it (the shape of a real one: a user input, a tool call, its result, the answer).
const at = (s: number) => new Date(Date.UTC(2026, 10, 21, 4, 55, s)).toISOString().replace('.000Z', 'Z')
const ask = (i: number, s: number) => ({ step_index: i, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: at(s), content: '<USER_REQUEST>\nrun it\n</USER_REQUEST>' })
const call = (i: number, s: number) => ({ step_index: i, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: at(s), model: 'gemini-4-neon-high', input_tokens: 9676, cache_read_tokens: 0, output_tokens: 230, tool_calls: [{ name: 'run_command', args: {} }] })
const result = (i: number, s: number) => ({ step_index: i, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: at(s), content: 'Command exited with code 0.' })
const answer = (i: number, s: number, text = 'done') => ({ step_index: i, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: at(s), model: 'gemini-4-neon-high', input_tokens: 2358, cache_read_tokens: 7635, output_tokens: 171, content: text, thinking: 'Done.' })
const lines = (...steps: object[]) => steps.map(s => JSON.stringify(s)).join('\n') + '\n'

const dir = mkdtempSync(join(tmpdir(), 'hydra-agy-session-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
let n = 0
// A session whose hook said `live`, with the transcript `body`; returns its id and transcript path.
function session(body: string, state: Partial<{ live: string; backgroundWork: boolean }> = {}) {
  const id = `s${++n}`, transcriptPath = join(dir, `${id}.jsonl`)
  writeFileSync(transcriptPath, body)
  mkdirSync(agyStateDir(), { recursive: true })
  writeFileSync(agyStateFile(id), JSON.stringify({ conversationId: `conv-${id}`, transcriptPath, live: 'idle', backgroundWork: false, ...state }))
  return { id, transcriptPath }
}
const since = (s: number) => Date.UTC(2026, 10, 21, 4, 55, s) + 400   // a message arriving 0.4 s into second s

beforeEach(() => rmSync(agyStateDir(), { recursive: true, force: true }))

test('a turn is over when agy has stopped and the transcript ends in an answer to a message from at or after the delivery', () => {
  const { id } = session(lines(ask(0, 17), call(1, 17), result(2, 20), answer(3, 20, 'all done')))
  expect(agyTurn(id, since(17))).toEqual({ complete: true, text: 'all done' })   // the delivery's own second counts
  expect(agyTurn(id, since(16))).toEqual({ complete: true, text: 'all done' })
})

test('the answer of an earlier turn is not the answer of a message delivered after it', () => {
  const { id } = session(lines(ask(0, 17), answer(1, 18)))
  expect(agyTurn(id, since(30))).toEqual({ complete: false, text: null })
})

test('a turn is not over while agy works, while a command it started runs, or while the last step is a tool call', () => {
  const done = lines(ask(0, 17), answer(1, 18))
  expect(agyTurn(session(done, { live: 'working' }).id, since(17)).complete).toBe(false)
  expect(agyTurn(session(done, { backgroundWork: true }).id, since(17)).complete).toBe(false)
  expect(agyTurn(session(lines(ask(0, 17), call(1, 18))).id, since(17)).complete).toBe(false)
  expect(agyTurn('no-such-session', 0)).toEqual({ complete: false, text: null })
})

test('a transcript line agy is still writing is skipped, not an error', () => {
  const { id } = session(lines(ask(0, 17), answer(1, 18, 'ok')) + '{"step_index":2,"type":"PLAN')
  expect(agyTurn(id, since(17))).toEqual({ complete: true, text: 'ok' })
})

test('only the last user input counts: an answer to an earlier message is not the answer to a later one', () => {
  const { id } = session(lines(ask(0, 10), answer(1, 11, 'first'), ask(2, 30), answer(3, 31, 'second')))
  expect(agyTurn(id, since(30))).toEqual({ complete: true, text: 'second' })
  expect(agyTurn(id, since(40)).complete).toBe(false)   // nothing came after a message delivered later than the last input
})

test('a user input with no readable time is not taken as the message\'s turn', () => {
  const { id } = session(lines({ ...ask(0, 17), created_at: undefined }, answer(1, 18)))
  expect(agyTurn(id, since(17)).complete).toBe(false)
})

test('a tool call that also carries text is not the answer', () => {
  const { id } = session(lines(ask(0, 17), { ...call(1, 18), content: 'let me run that' }))
  expect(agyTurn(id, since(17)).complete).toBe(false)
})

test('a turn whose tool output is far larger than the first read still finds its user input', () => {
  const big = { ...result(2, 19), content: 'x'.repeat(1_200_000) }   // the whole file is far over the 256 KB tail
  const { id } = session(lines(ask(0, 17), call(1, 18), big, answer(3, 20, 'found it')))
  expect(agyTurn(id, since(17))).toEqual({ complete: true, text: 'found it' })
})

test('context is the last model call\'s input plus what came from cache', () => {
  expect(agyContextTokens(session(lines(ask(0, 17), call(1, 17), result(2, 18), answer(3, 19))).id)).toBe(2358 + 7635)
  expect(agyContextTokens('no-such-session')).toBeNull()
})

test('spend sums every model call, and a second read adds only what was appended', () => {
  const { id, transcriptPath } = session(lines(ask(0, 17), call(1, 17), result(2, 18), answer(3, 19)))
  const first = agyUsageTotals(id, undefined)!
  expect(first.totals).toEqual({ inputTokens: 9676 + 2358, outputTokens: 230 + 171, cacheCreateTokens: 0, cacheReadTokens: 7635 })
  expect(first.providerSessionId).toBe(`conv-${id}`)
  appendFileSync(transcriptPath, lines(ask(4, 40), answer(5, 41)))
  const second = agyUsageTotals(id, first.cursor)!
  expect(second.totals.inputTokens).toBe(9676 + 2358 * 2)
  expect(second.restarted).toBe(false)
  expect(agyUsageTotals(id, second.cursor)!.totals).toEqual(second.totals)   // nothing appended: nothing added
})

test('a shorter transcript, or another conversation, starts the count over', () => {
  const { id, transcriptPath } = session(lines(ask(0, 17), answer(1, 18)))
  const first = agyUsageTotals(id, undefined)!
  writeFileSync(transcriptPath, lines(ask(0, 17)))
  expect(agyUsageTotals(id, first.cursor)).toMatchObject({ restarted: true, totals: { inputTokens: 0 } })
  writeFileSync(transcriptPath, lines(ask(0, 17), answer(1, 18), ask(2, 30), answer(3, 31)))   // longer than before: only the conversation id differs
  writeFileSync(agyStateFile(id), JSON.stringify({ conversationId: 'other', transcriptPath, live: 'idle', backgroundWork: false }))
  expect(agyUsageTotals(id, first.cursor)!.restarted).toBe(true)
  expect(agyUsageTotals('no-such-session', undefined)).toBeNull()
})

test('no word from agy yet reads as no state', () => {
  expect(agyState('nobody')).toBeNull()
})
