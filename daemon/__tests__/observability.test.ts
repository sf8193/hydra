import { describe, test, expect, afterEach } from 'bun:test'
import { openSync, writeSync, closeSync, writeFileSync, readFileSync, statSync, existsSync, unlinkSync, mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { trimSpawnLog, buildCrashNotice, buildAutopsy } from '../observability.js'
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

  test("pipe-pane's append fd stays valid across the in-place truncate (inode preserved)", () => {
    const p = tmpFile('append.log')
    writeFileSync(p, ('a'.repeat(100) + '\n').repeat(70000)) // ~7MB
    const inoBefore = statSync(p).ino
    const appendFd = openSync(p, 'a') // like `cat >> log`, opened BEFORE the trim

    trimSpawnLog(p)

    // Refutes "writeFileSync('w') replaces the inode": O_TRUNC truncates in place,
    // so the path still points at the same inode the append fd holds.
    expect(statSync(p).ino).toBe(inoBefore)

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

describe('buildCrashNotice (LINK, not CONVEY)', () => {
  test('links the on-disk black box and offers resume/respawn', () => {
    const out = buildCrashNotice(fakeInfo({ spawnLogPath: '/home/u/.claude/spawn-logs/ember-42.log' }))
    expect(out.includes('/home/u/.claude/spawn-logs/ember-42.log')).toBe(true) // the LINK
    expect(out.includes('ask me to read it')).toBe(true)
    expect(out.includes('resume')).toBe(true)
    expect(out.includes('respawn')).toBe(true)
  })

  test('conveys no raw pane content — the notice takes only metadata, never the tail', () => {
    const out = buildCrashNotice(fakeInfo({ spawnLogPath: '/tmp/x.log' }))
    // No code fence: raw pane output is never posted to the channel by the daemon.
    expect(out.includes('```')).toBe(false)
  })

  test('omits the black-box clause when no pane log was captured', () => {
    const out = buildCrashNotice(fakeInfo({ spawnLogPath: undefined }))
    expect(out.includes('Black box:')).toBe(false)
    expect(out.includes('respawn')).toBe(true) // still actionable
  })
})

// Note: tailSpawnLog is a thin `tail -n` subprocess wrapper — deliberately not
// unit-tested here. It was verified out-of-band (seeks from the end, no full read
// into memory) against a 500k-line file, and the repo's full-suite run has a
// pre-existing cross-file isolation bug that corrupts subprocess-based tests.

const NOW = 1_000_000_000
function fakeInfo(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: 'sess-1',
    tmuxName: 'discord-ember',
    threadId: 't1',
    topic: 'build critic',
    createdAt: NOW - 40_000, // 40s lifetime
    lastActive: NOW - 5_000, // 5s idle at death
    ...over,
  } as unknown as SessionInfo
}

describe('buildAutopsy', () => {
  test('reports "never sampled" when no vitals were taken (sub-60s death)', () => {
    const out = buildAutopsy(fakeInfo(), 'crashed', [], NOW, undefined)
    expect(out.includes('last RSS: never sampled')).toBe(true)
    expect(out.includes('last output: none captured')).toBe(true)
  })

  test('renders an injected RSS sample with its "before death" age', () => {
    const out = buildAutopsy(fakeInfo(), 'crashed', [], NOW, { rssMB: 512, at: NOW - 8_000 })
    expect(out.includes('last RSS: 512MB (8s before death)')).toBe(true)
  })

  test('renders the pane tail with a count and per-line prefix', () => {
    const out = buildAutopsy(fakeInfo(), 'crashed', ['boom', 'stack frame'], NOW, undefined)
    expect(out.includes('last output (2 lines):')).toBe(true)
    expect(out.includes('  | boom')).toBe(true)
    expect(out.includes('  | stack frame')).toBe(true)
  })

  test('durations render at exact second resolution (a 40s death is not "0m")', () => {
    const out = buildAutopsy(fakeInfo(), 'crashed', [], NOW, undefined)
    expect(out.includes('lifetime: 40s, idle at death: 5s')).toBe(true)
  })

  test('transcript reads "not found" when the claude id resolves to no file', () => {
    const out = buildAutopsy(fakeInfo({ claudeSessionId: 'no-such-claude-id-xyz' }), 'crashed', [], NOW, undefined)
    expect(out.includes('transcript: not found')).toBe(true)
  })
})
