import { afterAll, beforeEach, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { agyContextTokens, agyHasNewUserInput, agyState, agyStateDir, agyStateFile, agyTranscriptCursor, agyTurn, collapse } from '../../engines/agy-session.js'
import { formatNotification } from '../../shared/constants.js'

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

test('a user input further back than the read cap is not searched for: the turn reads as not over', () => {
  const big = { ...result(2, 19), content: 'x'.repeat(17_000_000) }
  const { id } = session(lines(ask(0, 17), call(1, 18), big, answer(3, 20, 'too far')))
  expect(agyTurn(id, since(17)).complete).toBe(false)
})

test('context is the last model call\'s input plus what came from cache', () => {
  expect(agyContextTokens(session(lines(ask(0, 17), call(1, 17), result(2, 18), answer(3, 19))).id)).toBe(2358 + 7635)
  expect(agyContextTokens('no-such-session')).toBeNull()
})

test('no word from agy yet reads as no state', () => {
  expect(agyState('nobody')).toBeNull()
})

test('agyHasNewUserInput reads only newly appended bytes, matches USER_INPUT at or after delivery second, and ignores older or non-input steps', () => {
  const body = (t: string) => `<USER_REQUEST>\n<channel source="hydra">\n${t}\n</channel>\n</USER_REQUEST>`
  const needle = collapse('<channel source="hydra">\ncheck the build\n</channel>').slice(-40)
  // Pre-existing identical USER_INPUT before cursor is never matched.
  const { id, transcriptPath } = session(lines({ ...ask(0, 17), content: body('check the build') }))
  const cursor = agyTranscriptCursor(id)
  expect(agyHasNewUserInput(id, needle, since(17), cursor)).toBe(false)

  // Non-qualifying appends (older timestamp, PLANNER_RESPONSE, missing created_at) advance cursor without matching.
  appendFileSync(transcriptPath, lines(
    { ...ask(1, 10), content: body('check the build') },
    { ...answer(2, 17, body('check the build')) },
    { ...ask(3, 17), created_at: undefined, content: body('check the build') },
  ))
  expect(agyHasNewUserInput(id, needle, since(17), cursor)).toBe(false)
  expect(cursor.offset).toBeGreaterThan(0)

  // A large tool output appended before the matching input is scanned once, cursor advances, and the subsequent USER_INPUT matches.
  appendFileSync(transcriptPath, lines({ ...result(4, 18), content: 'x'.repeat(1_200_000) }))
  expect(agyHasNewUserInput(id, needle, since(17), cursor)).toBe(false)
  const afterBig = cursor.offset
  expect(afterBig).toBeGreaterThan(1_200_000)

  appendFileSync(transcriptPath, lines({ ...ask(5, 19), content: body('check  the\n  build') }))
  expect(agyHasNewUserInput(id, needle, since(17), cursor)).toBe(true)

  // Missing session or missing transcript returns false cleanly.
  expect(agyHasNewUserInput('no-such-session', needle, since(17), agyTranscriptCursor('no-such-session'))).toBe(false)
  writeFileSync(agyStateFile('missing-transcript'), JSON.stringify({ conversationId: 'c', transcriptPath: join(dir, 'does-not-exist.jsonl'), live: 'idle', backgroundWork: false }))
  expect(agyHasNewUserInput('missing-transcript', needle, since(17), agyTranscriptCursor('missing-transcript'))).toBe(false)
})

test('agyHasNewUserInput handles partial lines across poll ticks without losing a line being written', () => {
  const needle = collapse('<channel source="hydra">\nsplit write\n</channel>').slice(-40)
  const { id, transcriptPath } = session('')
  const cursor = agyTranscriptCursor(id)
  const full = JSON.stringify({ ...ask(0, 17), content: '<USER_REQUEST>\n<channel source="hydra">\nsplit write\n</channel>\n</USER_REQUEST>' }) + '\n'
  appendFileSync(transcriptPath, full.slice(0, 40))
  expect(agyHasNewUserInput(id, needle, since(17), cursor)).toBe(false)
  expect(cursor.offset).toBe(0)   // no newline yet, so cursor stayed before the partial line
  expect(cursor.lastSize).toBe(40)
  // Unchanged file size short-circuits without re-reading the trailing partial line
  expect(agyHasNewUserInput(id, needle, since(17), cursor)).toBe(false)
  appendFileSync(transcriptPath, full.slice(40))
  expect(agyHasNewUserInput(id, needle, since(17), cursor)).toBe(true)
})

test('agyHasNewUserInput matches a real multi-line agy USER_INPUT fixture built via formatNotification', () => {
  const fixturePath = join(import.meta.dir, 'fixtures', 'agy-session.jsonl')
  const fixtureBody = readFileSync(fixturePath, 'utf8')
  const { id, transcriptPath } = session('')
  const cursor = agyTranscriptCursor(id)
  appendFileSync(transcriptPath, fixtureBody)
  const body = [
    '[PR Feedback] **acme/repo#988** — 3 new item(s)',
    '',
    '💬 **Review from @reviewer** — COMMENTED',
    '> Review of `f98fe025`: multi-line paste with "quotes", \'singles\', `backticks`, and URLs.',
    '',
    '💬 **@reviewer** `cli/init.ts:360`',
    '> **Should-fix.** `Bun.spawnSync([\'claude\', ...])` throws when `claude` is not on `$PATH`.',
    '> https://github.com/acme/repo/pull/988#discussion_r1001',
    '',
    '💬 **@reviewer** `cli/init.ts:465`',
    '> **Should-fix.** Use `{ mode: 0o600, flag: \'wx\' }` for both writes.',
    '> https://github.com/acme/repo/pull/988#discussion_r1002',
    '',
    '---',
    'Categorize the above into: **real bugs to fix**, **valid suggestions**, **false positives/noise**, **nits**.',
  ].join('\n')
  const pasted = formatNotification(body, { source: 'pr-watch', initiator: 'pr-watch' })
  expect(agyHasNewUserInput(id, collapse(pasted), Date.UTC(2026, 10, 23, 21, 39, 10), cursor)).toBe(true)
})
