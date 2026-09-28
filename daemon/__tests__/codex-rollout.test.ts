import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { codexTurnBoundary } from '../codex-rollout.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'codex-rollout-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const ev = (type: string, extra: Record<string, unknown> = {}) => JSON.stringify({ type: 'event_msg', payload: { type, ...extra } })
const put = (thread: string, lines: string[], day = '2026/09/28') => {
  mkdirSync(join(dir, 'sessions', day), { recursive: true })
  writeFileSync(join(dir, 'sessions', day, `rollout-2026-09-28T07-00-00-${thread}.jsonl`), lines.join('\n') + '\n')
}

describe('codexTurnBoundary', () => {
  test('the latest boundary wins: started is open; complete and aborted are closed', () => {
    put('t-open', [ev('task_started'), ev('task_complete'), ev('task_started')])
    put('t-done', [ev('task_started'), ev('token_count'), ev('task_complete', { last_agent_message: 'x' })])
    put('t-abort', [ev('task_started'), ev('turn_aborted')])
    expect([codexTurnBoundary(dir, 't-open'), codexTurnBoundary(dir, 't-done'), codexTurnBoundary(dir, 't-abort')]).toEqual(['open', 'closed', 'closed'])
  })
  test('unknown: no file, wrong thread, no boundary in view, missing dir', () => {
    put('t-none', [ev('token_count'), JSON.stringify({ type: 'response_item', payload: { type: 'message' } })])
    expect([codexTurnBoundary(dir, 't-none'), codexTurnBoundary(dir, 't-other'), codexTurnBoundary(join(dir, 'nope'), 't-none')]).toEqual([null, null, null])
  })
  test('only event_msg records are boundaries: mentions in text, or the same payload type in another record kind, are not', () => {
    put('t-noise', [ev('task_started'),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', content: 'event_msg task_complete "type":"task_complete"' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'task_complete' }, note: 'event_msg' })]) // right payload type, wrong record type
    expect(codexTurnBoundary(dir, 't-noise')).toBe('open')
  })
  test('decoys are skipped: a non-numeric sibling of the year dirs, and a file that is not a rollout', () => {
    mkdirSync(join(dir, 'sessions', 'zzz-tmp'), { recursive: true })
    writeFileSync(join(dir, 'sessions', 'zzz-tmp', 'x'), '')
    mkdirSync(join(dir, 'sessions', '2026', '09', '28'), { recursive: true })
    writeFileSync(join(dir, 'sessions', '2026', '09', '28', 'notrollout-2026-t-decoy.jsonl'), ev('task_complete') + '\n')
    expect(codexTurnBoundary(dir, 't-decoy')).toBeNull()
  })
  test('junk and a partial first line in the tail are skipped', () => {
    put('t-junk', ['{"type":"event_msg","payload":{"ty', ev('task_complete'), 'not json at all'])
    expect(codexTurnBoundary(dir, 't-junk')).toBe('closed')
  })
  test('a boundary older than the 64KB tail is unknown, not guessed', () => {
    put('t-big', [ev('task_complete'), JSON.stringify({ type: 'response_item', pad: 'x'.repeat(70 * 1024) })])
    expect(codexTurnBoundary(dir, 't-big')).toBeNull()
  })
  test('the newest day directory wins when a thread has files on several days', () => {
    put('t-days', [ev('task_started')], '2026/09/27')
    put('t-days', [ev('task_complete')], '2026/09/28')
    expect(codexTurnBoundary(dir, 't-days')).toBe('closed')
  })
})
