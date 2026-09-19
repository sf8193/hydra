import { describe, test, expect } from 'bun:test'
import { chmodSync, mkdtempSync, writeFileSync, appendFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { latestCwd, newCursor, projectDirName, readUsageDelta, totalsChanged, transcriptPath } from '../usage.js'

const line = (usage: Record<string, number>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ ...extra, message: { role: 'assistant', usage } }) + '\n'

function fixture(body: string): string {
  const f = join(mkdtempSync(join(tmpdir(), 'usage-')), 't.jsonl')
  writeFileSync(f, body)
  return f
}

describe('usage: token extraction', () => {
  test('sums the four counters across turns', () => {
    const f = fixture(
      line({ input_tokens: 10, output_tokens: 3, cache_creation_input_tokens: 100, cache_read_input_tokens: 900 })
      + line({ input_tokens: 5, output_tokens: 7, cache_creation_input_tokens: 50, cache_read_input_tokens: 400 }),
    )
    expect(readUsageDelta(f, newCursor()).totals).toEqual({
      inputTokens: 15, outputTokens: 10, cacheCreateTokens: 150, cacheReadTokens: 1300,
    })
  })

  test('a second read does no work and reports the same totals', () => {
    const f = fixture(line({ input_tokens: 1, output_tokens: 2 }))
    const first = readUsageDelta(f, newCursor())
    const second = readUsageDelta(f, first)
    expect(second.offset).toBe(first.offset)
    expect(second.totals).toEqual(first.totals)
  })

  test('only appended turns are added on the next read', () => {
    const f = fixture(line({ output_tokens: 5 }))
    const first = readUsageDelta(f, newCursor())
    appendFileSync(f, line({ output_tokens: 6 }))
    expect(readUsageDelta(f, first).totals.outputTokens).toBe(11)
  })

  test('a half-written trailing line is not consumed', () => {
    const f = fixture(line({ output_tokens: 4 }) + '{"message":{"usage":{"output_tokens":9')
    const c = readUsageDelta(f, newCursor())
    expect(c.totals.outputTokens).toBe(4)
    appendFileSync(f, '}}}\n')
    expect(readUsageDelta(f, c).totals.outputTokens).toBe(13)
  })

  test('a truncated file restarts rather than reporting nonsense', () => {
    const f = fixture(line({ output_tokens: 8 }) + line({ output_tokens: 8 }))
    const c = readUsageDelta(f, newCursor())
    expect(c.totals.outputTokens).toBe(16)
    writeFileSync(f, line({ output_tokens: 1 }))
    const after = readUsageDelta(f, c)
    expect(after.totals.outputTokens, 'stale offset must not be trusted').toBe(1)
  })

  test('malformed lines and absent counters are skipped, not fatal', () => {
    const f = fixture('not json\n' + JSON.stringify({ message: {} }) + '\n' + line({ output_tokens: 2 }))
    expect(readUsageDelta(f, newCursor()).totals.outputTokens).toBe(2)
  })

  test.each([
    ['9; DROP', 0],
    ['9', 0],
    [true, 0],
    [Infinity, 0],
    [9.7, 9],
  ] as const)('a counter of %p contributes %p', (raw, want) => {
    const f = fixture(JSON.stringify({ message: { usage: { output_tokens: raw } } }) + '\n')
    expect(readUsageDelta(f, newCursor()).totals.outputTokens).toBe(want)
  })

  test('a missing file leaves the cursor untouched', () => {
    const c = newCursor()
    expect(readUsageDelta('/nope/absent.jsonl', c)).toBe(c)
  })

  // stat succeeds and open fails — the shape of a file vanishing or locked
  // under the tick, which has no catch around it.
  test('a file that stats but cannot be opened does not throw', () => {
    const f = fixture(line({ output_tokens: 3 }))
    chmodSync(f, 0o000)
    try {
      if (readUsageDelta(f, newCursor()).totals.outputTokens === 3) return // running as root
      expect(() => readUsageDelta(f, newCursor())).not.toThrow()
      expect(() => latestCwd(f)).not.toThrow()
      expect(latestCwd(f)).toBeUndefined()
    } finally { chmodSync(f, 0o600) }
  })
})

describe('usage: nothing but integers can escape', () => {
  // This reads the directory that holds conversation content.
  test('no text from the transcript reaches the totals', () => {
    const secrets = ['123-45-6789', 'wire $2.4M to Acme Corp', 'kevin@example.com', '/Users/kevin/secret-repo']
    const f = fixture(
      JSON.stringify({
        cwd: '/Users/kevin/secret-repo',
        message: { role: 'assistant', content: secrets.join(' '), usage: { output_tokens: 3 } },
        summary: secrets.join(' | '),
      }) + '\n',
    )
    const serialized = JSON.stringify(readUsageDelta(f, newCursor()).totals)
    for (const s of secrets) expect(serialized, `leaked ${s}`).not.toContain(s)
    expect(Object.values(readUsageDelta(f, newCursor()).totals).every(v => typeof v === 'number')).toBe(true)
  })
})

describe('usage: locating the transcript', () => {
  test.each([
    ['/Users/kevin/RubymineProjects/hydra', '-Users-kevin-RubymineProjects-hydra'],
    ['/Users/kevin/RubymineProjects/.worktrees/hydra-atlas', '-Users-kevin-RubymineProjects--worktrees-hydra-atlas'],
  ])('%p encodes to %p', (cwd, dir) => {
    expect(projectDirName(cwd)).toBe(dir)
    expect(transcriptPath(cwd, 'abc')).toContain(join(dir, 'abc.jsonl'))
  })

  test('the latest cwd wins, so a session that moved is attributed where it is', () => {
    const f = fixture(
      JSON.stringify({ cwd: '/start/here' }) + '\n' + JSON.stringify({ cwd: '/moved/there' }) + '\n',
    )
    expect(latestCwd(f)).toBe('/moved/there')
  })

  test('a transcript with no cwd reports none', () => {
    expect(latestCwd(fixture(line({ output_tokens: 1 })))).toBeUndefined()
  })
})

describe('usage: change detection', () => {
  test('only a real move counts as changed', () => {
    const a = { inputTokens: 1, outputTokens: 2, cacheCreateTokens: 3, cacheReadTokens: 4 }
    expect(totalsChanged(a, { ...a })).toBe(false)
    expect(totalsChanged(a, { ...a, cacheReadTokens: 5 })).toBe(true)
  })
})
