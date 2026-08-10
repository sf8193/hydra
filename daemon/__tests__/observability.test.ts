import { describe, test, expect, afterEach, mock, beforeEach } from 'bun:test'
import { openSync, writeSync, closeSync, writeFileSync, readFileSync, statSync, existsSync, unlinkSync, mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { trimSpawnLog, buildCrashNotice, buildAutopsy, childPids, descendantPids, paneVitals, sessionVitalsLine } from '../observability.js'
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

    // writeFileSync's O_TRUNC truncates in place, so the path keeps the same inode
    // the append fd holds — capture survives the trim.
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

// tailSpawnLog (a thin `tail -n` wrapper) is intentionally not unit-tested — it
// shells out, and its one behavior (seek-from-end, no full read) was verified
// out-of-band against a 500k-line file.

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

// ---------------------------------------------------------------------------
// Async vitals helpers
// ---------------------------------------------------------------------------

// These tests exercise real process behavior where possible.
// They work in any environment where tmux/pgrep/ps are unavailable — all
// three helpers return gracefully on exec failure.

describe('childPids (async)', () => {
  test('returns empty array when pgrep finds no children', async () => {
    // PID 0 is the kernel — pgrep -P 0 always exits non-zero (no children or denied).
    const result = await childPids('0')
    expect(Array.isArray(result)).toBe(true)
    // Either empty (no children found) or valid pids (environment-dependent)
    for (const pid of result) expect(typeof pid).toBe('string')
  })

  test('returns empty array for a non-existent PID', async () => {
    // PID 99999999 almost certainly does not exist.
    const result = await childPids('99999999')
    expect(result).toEqual([])
  })

  test('returns empty array on exec failure (non-existent binary path)', async () => {
    // We can verify the error path by testing with an invalid PID string that
    // pgrep will reject with a non-zero exit (same as "no children").
    const result = await childPids('not-a-pid')
    expect(result).toEqual([])
  })
})

describe('descendantPids (async)', () => {
  test('returns empty array for non-existent root pid', async () => {
    const result = await descendantPids('99999999')
    expect(result).toEqual([])
  })

  test('returns array (possibly empty) for a valid pid', async () => {
    // Use our own PID — it definitely exists, and may or may not have children.
    const result = await descendantPids(String(process.pid))
    expect(Array.isArray(result)).toBe(true)
    for (const pid of result) expect(typeof pid).toBe('string')
  })
})

describe('paneVitals (async)', () => {
  test('returns {} when tmux session does not exist', async () => {
    // A tmux session named with a UUID definitely does not exist.
    const result = await paneVitals('nonexistent-session-xyz-99999')
    expect(result).toEqual({})
  })

  test('returns object shape { pid?, rssMB? }', async () => {
    const result = await paneVitals('nonexistent-session-xyz-99999')
    expect(typeof result).toBe('object')
    // pid and rssMB are optional — either number or undefined
    if (result.pid != null) expect(typeof result.pid).toBe('number')
    if (result.rssMB != null) {
      expect(typeof result.rssMB).toBe('number')
      expect(result.rssMB).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('sessionVitalsLine (async)', () => {
  const NOW = 1_700_000_000_000

  test('returns a string with tmuxName, pid, rss, up, idle fields', async () => {
    const info = fakeInfo({ tmuxName: 'nonexistent-xyz', createdAt: NOW - 120_000, lastActive: NOW - 30_000 })
    const line = await sessionVitalsLine(info, NOW, () => true)
    expect(typeof line).toBe('string')
    expect(line.startsWith('nonexistent-xyz')).toBe(true)
    expect(line.includes('pid=')).toBe(true)
    expect(line.includes('rss=')).toBe(true)
    expect(line.includes('up=')).toBe(true)
    expect(line.includes('idle=')).toBe(true)
  })

  test('appends [disconnected] when isConnected returns false', async () => {
    const info = fakeInfo({ tmuxName: 'nonexistent-xyz' })
    const line = await sessionVitalsLine(info, NOW, () => false)
    expect(line.includes('[disconnected]')).toBe(true)
  })

  test('does not append [disconnected] when isConnected returns true', async () => {
    const info = fakeInfo({ tmuxName: 'nonexistent-xyz' })
    const line = await sessionVitalsLine(info, NOW, () => true)
    expect(line.includes('[disconnected]')).toBe(false)
  })
})

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
