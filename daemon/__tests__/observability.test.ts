import { describe, test, expect, afterEach } from 'bun:test'
import { openSync, writeSync, closeSync, writeFileSync, readFileSync, statSync, existsSync, unlinkSync, mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { trimSpawnLog, buildCrashExcerpt, buildAutopsy } from '../observability.js'
import type { SessionInfo } from '../sessions.js'

const tmp = mkdtempSync(join(tmpdir(), 'obs-test-'))
const paths: string[] = []
function tmpFile(name: string): string {
  const p = join(tmp, name)
  paths.push(p)
  return p
}
afterEach(() => {
  for (const p of paths) if (existsSync(p)) unlinkSync(p)
  paths.length = 0
})

const MB = 1024 * 1024

describe('trimSpawnLog (front-trim cap)', () => {
  test('over-cap file is front-trimmed to the ~2MB tail, keeping the newest output', () => {
    const p = tmpFile('big.log')
    let n = 0
    let total = 0
    const lines: string[] = []
    while (total < 6 * MB) {
      const l = `line-${n++} ${'x'.repeat(80)}`
      lines.push(l)
      total += l.length + 1
    }
    const lastLine = `line-${n - 1}`
    writeFileSync(p, lines.join('\n') + '\n')

    trimSpawnLog(p)

    const size = statSync(p).size
    const content = readFileSync(p, 'utf8')
    expect(size).toBeLessThanOrEqual(5 * MB)
    expect(size).toBeGreaterThan(MB) // kept ~2MB, not emptied
    expect(content.startsWith('line-')).toBe(true) // partial first line dropped
    expect(content.includes(lastLine)).toBe(true) // dying tail survives
  })

  test("pipe-pane's append fd stays valid across the in-place truncate", () => {
    const p = tmpFile('append.log')
    writeFileSync(p, ('a'.repeat(100) + '\n').repeat(70000)) // ~7MB
    const appendFd = openSync(p, 'a') // like `cat >> log`, opened BEFORE the trim

    trimSpawnLog(p)
    writeSync(appendFd, Buffer.from('POST-TRIM-MARKER\n'))
    closeSync(appendFd)

    const after = readFileSync(p, 'utf8')
    expect(after.includes('POST-TRIM-MARKER')).toBe(true) // capture continued
    expect(after.includes('\0')).toBe(false) // no NUL hole from a stale offset
  })

  test('under-cap file is left untouched', () => {
    const p = tmpFile('small.log')
    const body = 'just a little output\n'
    writeFileSync(p, body)
    trimSpawnLog(p)
    expect(readFileSync(p, 'utf8')).toBe(body)
  })

  test('missing file does not throw', () => {
    expect(() => trimSpawnLog(join(tmp, 'does-not-exist.log'))).not.toThrow()
  })
})

describe('buildCrashExcerpt (channel-safe crash tail)', () => {
  test('empty tail → empty string (caller omits the block)', () => {
    expect(buildCrashExcerpt([])).toBe('')
  })

  test('keeps only the last 8 lines', () => {
    const tail = Array.from({ length: 20 }, (_, i) => `row ${i}`)
    const out = buildCrashExcerpt(tail).split('\n')
    expect(out.length).toBe(8)
    expect(out[0]).toBe('row 12')
    expect(out[7]).toBe('row 19')
  })

  test('neutralizes backticks so they cannot close the fence', () => {
    const out = buildCrashExcerpt(['```danger```'])
    expect(out.includes('```')).toBe(false) // no run of three bare backticks
    expect(out.includes('`​')).toBe(true) // each backtick followed by ZWS
  })

  test('caps to 1500 chars (before ZWS insertion)', () => {
    const out = buildCrashExcerpt(['y'.repeat(5000)])
    expect(out.length).toBeLessThanOrEqual(1500)
  })
})

// Note: tailSpawnLog is a thin `tail -n` subprocess wrapper — deliberately not
// unit-tested here. It was verified out-of-band (seeks from the end, no full read
// into memory) against a 500k-line file, and the repo's full-suite run has a
// pre-existing cross-file isolation bug that corrupts subprocess-based tests.

function fakeInfo(over: Partial<SessionInfo> = {}): SessionInfo {
  const now = Date.now()
  return {
    sessionId: 'sess-1',
    tmuxName: 'discord-ember',
    threadId: 't1',
    topic: 'build critic',
    createdAt: now - 40_000, // 40s lifetime
    lastActive: now - 5_000,
    ...over,
  } as unknown as SessionInfo
}

describe('buildAutopsy', () => {
  test('reports "never sampled" when no vitals were taken (sub-60s death)', () => {
    const out = buildAutopsy(fakeInfo(), 'crashed', [])
    expect(out.includes('last RSS: never sampled')).toBe(true)
    expect(out.includes('last output: none captured')).toBe(true)
  })

  test('renders the pane tail with a count and per-line prefix', () => {
    const out = buildAutopsy(fakeInfo(), 'crashed', ['boom', 'stack frame'])
    expect(out.includes('last output (2 lines):')).toBe(true)
    expect(out.includes('  | boom')).toBe(true)
    expect(out.includes('  | stack frame')).toBe(true)
  })

  test('durations render at second resolution (a 40s death is not "0m")', () => {
    const out = buildAutopsy(fakeInfo(), 'crashed', [])
    expect(out).toMatch(/lifetime: (39|40)s/)
  })

  test('transcript reads "not found" when the claude id resolves to no file', () => {
    const out = buildAutopsy(fakeInfo({ claudeSessionId: 'no-such-claude-id-xyz' }), 'crashed', [])
    expect(out.includes('transcript: not found')).toBe(true)
  })
})
