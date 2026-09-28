import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { codexLastTurn } from '../codex-rollout.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'codex-rollout-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const ev = (type: string, extra: Record<string, unknown> = {}) => JSON.stringify({ type: 'event_msg', payload: { type, ...extra } })
const put = (thread: string, lines: string[], day = '2026/09/28') => {
  mkdirSync(join(dir, 'sessions', day), { recursive: true })
  writeFileSync(join(dir, 'sessions', day, `rollout-2026-09-28T07-00-00-${thread}.jsonl`), lines.join('\n') + '\n')
}

describe('codexLastTurn: boundary parsing', () => {
  test('the latest boundary wins: started is open; complete and aborted are closed', () => {
    put('t-open', [ev('task_started'), ev('task_complete'), ev('task_started')])
    put('t-done', [ev('task_started'), ev('token_count'), ev('task_complete', { last_agent_message: 'x' })])
    put('t-abort', [ev('task_started'), ev('turn_aborted')])
    expect([(codexLastTurn(dir, 't-open')?.boundary ?? null), (codexLastTurn(dir, 't-done')?.boundary ?? null), (codexLastTurn(dir, 't-abort')?.boundary ?? null)]).toEqual(['open', 'closed', 'closed'])
  })
  test('unknown: no file, wrong thread, no boundary in view, missing dir', () => {
    put('t-none', [ev('token_count'), JSON.stringify({ type: 'response_item', payload: { type: 'message' } })])
    expect([(codexLastTurn(dir, 't-none')?.boundary ?? null), (codexLastTurn(dir, 't-other')?.boundary ?? null), (codexLastTurn(join(dir, 'nope'), 't-none')?.boundary ?? null)]).toEqual([null, null, null])
  })
  test('only event_msg records are boundaries: mentions in text, or the same payload type in another record kind, are not', () => {
    put('t-noise', [ev('task_started'),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', content: 'event_msg task_complete "type":"task_complete"' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'task_complete' }, note: 'event_msg' })]) // right payload type, wrong record type
    expect((codexLastTurn(dir, 't-noise')?.boundary ?? null)).toBe('open')
  })
  test('decoys are skipped: a non-numeric sibling of the year dirs, and a file that is not a rollout', () => {
    mkdirSync(join(dir, 'sessions', 'zzz-tmp'), { recursive: true })
    writeFileSync(join(dir, 'sessions', 'zzz-tmp', 'x'), '')
    mkdirSync(join(dir, 'sessions', '2026', '09', '28'), { recursive: true })
    writeFileSync(join(dir, 'sessions', '2026', '09', '28', 'notrollout-2026-t-decoy.jsonl'), ev('task_complete') + '\n')
    expect((codexLastTurn(dir, 't-decoy')?.boundary ?? null)).toBeNull()
  })
  test('junk and a partial first line in the tail are skipped', () => {
    put('t-junk', ['{"type":"event_msg","payload":{"ty', ev('task_complete'), 'not json at all'])
    expect((codexLastTurn(dir, 't-junk')?.boundary ?? null)).toBe('closed')
  })
  test('a boundary older than the 64KB tail is unknown, not guessed', () => {
    put('t-big', [ev('task_complete'), JSON.stringify({ type: 'response_item', pad: 'x'.repeat(70 * 1024) })])
    expect((codexLastTurn(dir, 't-big')?.boundary ?? null)).toBeNull()
  })
  test('the newest day directory wins when a thread has files on several days', () => {
    put('t-days', [ev('task_started')], '2026/09/27')
    put('t-days', [ev('task_complete')], '2026/09/28')
    expect((codexLastTurn(dir, 't-days')?.boundary ?? null)).toBe('closed')
  })
})

describe('codexLastTurn', () => {
  const stamped = (type: string, timestamp: string, payload: Record<string, unknown> = {}) => JSON.stringify({ timestamp, type: 'event_msg', payload: { type, ...payload } })
  test('a finished turn carries its answer and time; an open or aborted one carries no answer', () => {
    put('t-done', [stamped('task_started', '2026-09-28T14:00:00.000Z'), stamped('task_complete', '2026-09-28T14:01:00.500Z', { last_agent_message: 'the answer' })])
    put('t-open', [stamped('task_started', '2026-09-28T14:00:00.000Z')])
    put('t-abort', [stamped('task_started', '2026-09-28T14:00:00.000Z'), stamped('turn_aborted', '2026-09-28T14:00:30.000Z')])
    expect(codexLastTurn(dir, 't-done')).toEqual({ boundary: 'closed', answer: 'the answer', at: Date.parse('2026-09-28T14:01:00.500Z') })
    expect(codexLastTurn(dir, 't-open')).toEqual({ boundary: 'open', answer: null, at: Date.parse('2026-09-28T14:00:00.000Z') })
    expect(codexLastTurn(dir, 't-abort')).toEqual({ boundary: 'closed', answer: null, at: Date.parse('2026-09-28T14:00:30.000Z') })
  })
  test('blank or missing answer and a bad timestamp read as null, not as text', () => {
    put('t-blank', [stamped('task_complete', 'not a date', { last_agent_message: '  ' })])
    put('t-none', [stamped('task_complete', '2026-09-28T14:00:00.000Z')])
    expect(codexLastTurn(dir, 't-blank')).toEqual({ boundary: 'closed', answer: null, at: null })
    expect(codexLastTurn(dir, 't-none')?.answer).toBeNull()
  })
})
