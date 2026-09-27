// S10-lite: Codex usage to Raindrop (A) and the restart gap (B).
//
// Live check, codex-cli 0.157.1, 2026-09-26, throwaway CODEX_HOME + private socket:
// - initialize, thread/start, turn/start "reply with the word ok", then turn/completed:
//   turn/start returned the turn with itemsView "notLoaded", items [].
//   turn/completed carried itemsView "summary", items [agentMessage "ok"].
// - After reconnecting, thread/resume returned turns[0] = { status: "completed",
//   itemsView: "full", completedAt: 1790489642 (epoch SECONDS), items: [userMessage,
//   agentMessage { text: "ok", phase: "final_answer" }] }. So the agentMessage text IS
//   present on resume, and Part B takes lastAgentText from the last agentMessage item
//   with non-empty text, whatever itemsView says. A "notLoaded" turn has no items, so
//   it gives null text.
// - The rollout was sessions/2026/09/26/rollout-2026-09-26T23-13-59-<threadId>.jsonl.
//   The filename ends with -<threadId>.jsonl. Its last token_count was
//   total_token_usage { input_tokens 17347, cached_input_tokens 13056,
//   cache_write_input_tokens 0, output_tokens 5, reasoning_output_tokens 0 }.

import { afterEach, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { _resetRolloutMemoForTesting, codexTotals, codexUsageTotals, findRollout, lastTokenUsage } from '../codex-rollout.js'

const dirs: string[] = []
afterEach(() => { _resetRolloutMemoForTesting(); while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

function tmp(): string { const d = mkdtempSync(join(tmpdir(), 's10-')); dirs.push(d); return d }

export const tc = (input: number, cached: number, output: number, extra: Record<string, number> = {}) => JSON.stringify({
  timestamp: '2026-09-27T06:14:02.841Z', type: 'event_msg',
  payload: { type: 'token_count', info: { total_token_usage: {
    input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output,
    reasoning_output_tokens: 0, total_tokens: input + output, ...extra,
  } } },
})
const other = (s: string) => JSON.stringify({ type: 'response_item', payload: { type: 'message', text: s } })

// A home with one rollout for `threadId`; returns the home dir and the file path.
export function plantRollout(home: string, threadId: string, lines: string[], day = '2026/09/26'): string {
  const dir = join(home, 'sessions', day)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `rollout-2026-09-26T23-13-59-${threadId}.jsonl`)
  writeFileSync(path, lines.map(l => l + '\n').join(''))
  return path
}

describe('rollout tail', () => {
  test('the last token_count wins, even with other records after it', () => {
    const p = plantRollout(tmp(), 't1', [tc(10, 5, 1), other('x'), tc(30, 20, 3), other('ünïcødé ✓'), other('y')])
    expect(lastTokenUsage(p)?.input_tokens).toBe(30)
  })

  test('chunk boundaries, including inside multibyte text, do not change the answer', () => {
    const p = plantRollout(tmp(), 't1', [tc(10, 5, 1), other('✓✓✓ ünïcødé'.repeat(20)), tc(31, 20, 3), other('✓'.repeat(50))])
    for (const chunk of [1, 3, 7, 64, 1 << 16]) expect(lastTokenUsage(p, chunk)?.input_tokens).toBe(31)
  })

  test('a partial final line is ignored', () => {
    const p = plantRollout(tmp(), 't1', [tc(10, 5, 1)])
    appendFileSync(p, tc(99, 5, 9).slice(0, -3))
    expect(lastTokenUsage(p)?.input_tokens).toBe(10)
    expect(lastTokenUsage(p, 5)?.input_tokens).toBe(10)
  })

  test('a complete final token_count without a trailing newline is still partial', () => {
    const p = plantRollout(tmp(), 't1', [tc(10, 5, 1)])
    appendFileSync(p, tc(99, 5, 9))
    expect(lastTokenUsage(p)?.input_tokens).toBe(10)
  })

  test('no token_count gives null', () => {
    expect(lastTokenUsage(plantRollout(tmp(), 't1', [other('a'), other('b')]))).toBeNull()
  })

  test('a missing file gives null', () => {
    expect(lastTokenUsage(join(tmp(), 'nope.jsonl'))).toBeNull()
  })

  test('the rollout is found by its thread-id suffix, not another thread\'s file', () => {
    const home = tmp()
    plantRollout(home, 'other-thread', [tc(1, 0, 1)], '2026/09/27')
    const mine = plantRollout(home, 't1', [tc(2, 0, 1)])
    expect(findRollout(home, 't1')).toBe(mine)
    expect(findRollout(home, 'missing')).toBeUndefined()
  })
})

describe('token mapping', () => {
  test('input excludes cached, cacheRead is cached, output includes reasoning (verified 16481 = 16363 + 118)', () => {
    expect(codexTotals({ input_tokens: 16481, cached_input_tokens: 16363, cache_write_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 30 }))
      .toEqual({ inputTokens: 118, cacheReadTokens: 16363, cacheCreateTokens: 0, outputTokens: 50 })
  })

  test('cache writes map to cacheCreate', () => {
    expect(codexTotals({ input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 7, output_tokens: 1 })?.cacheCreateTokens).toBe(7)
  })

  test('an unknown shape gives null', () => {
    expect(codexTotals({ input_tokens: 10, output_tokens: 1 })).toBeNull()
    expect(codexTotals({ input_tokens: '10', cached_input_tokens: 0, output_tokens: 1 })).toBeNull()
  })
})

describe('codexUsageTotals', () => {
  const subject = (home: string, codexThreadId = 't1') => ({ tmuxName: 'x', codexHomeName: 'h', codexThreadId, _home: home })
  const read = (s: ReturnType<typeof subject>, prev?: unknown) => codexUsageTotals(s, prev, () => s._home)

  test('growth is not a restart; the thread id is the provider session id', () => {
    const home = tmp()
    const p = plantRollout(home, 't1', [tc(100, 40, 5)])
    const a = read(subject(home))!
    expect(a).toMatchObject({ providerSessionId: 't1', restarted: false, totals: { inputTokens: 60, outputTokens: 5 } })
    appendFileSync(p, tc(200, 50, 9) + '\n')
    expect(read(subject(home), a.cursor)).toMatchObject({ restarted: false, totals: { inputTokens: 150 } })
  })

  test('a decrease is a restart', () => {
    const home = tmp()
    const p = plantRollout(home, 't1', [tc(1_460_000, 1_000_000, 900)])
    const a = read(subject(home))!
    appendFileSync(p, tc(117_000, 100_000, 20) + '\n')
    expect(read(subject(home), a.cursor)?.restarted).toBe(true)
  })

  test('a thread change is a restart', () => {
    const home = tmp()
    plantRollout(home, 't1', [tc(100, 0, 5)])
    plantRollout(home, 't2', [tc(500, 0, 50)])
    const a = read(subject(home, 't1'))!
    const b = read(subject(home, 't2'), a.cursor)!
    expect(b.providerSessionId).toBe('t2')
    expect(b.restarted, 'larger totals on a new thread are still a new baseline').toBe(true)
  })

  test('no thread id, no rollout, or no token_count gives null', () => {
    const home = tmp()
    plantRollout(home, 't1', [other('a')])
    expect(read({ ...subject(home), codexThreadId: undefined as any })).toBeNull()
    expect(read(subject(home, 'absent'))).toBeNull()
    expect(read(subject(home, 't1'))).toBeNull()
  })
})
