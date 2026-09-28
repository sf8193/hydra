import { describe, test, expect, afterEach } from 'bun:test'
import { openSync, writeSync, closeSync, writeFileSync, readFileSync, statSync, existsSync, unlinkSync, mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { trimSpawnLog, trimDaemonLog, buildCrashNotice, buildAutopsy, readConversationForensics, type ConversationForensics } from '../observability.js'
import { claudeTurnOutcome } from '../engines/claude-transcript.js'
import { codexTurnOutcome, defaultTurnSources, type TurnSources } from '../engines/codex-observation.js'
import { engines } from '../engines/instances.js'
import type { SessionInfo } from '../sessions.js'
import { nextResumeCount } from '../session-lifecycle.js'

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

describe('trimDaemonLog (HYDRA_LOG gating)', () => {
  // The trim mechanics are shared with trimSpawnLog above — both route through
  // frontTrim — so these cover only what is specific here: that the daemon
  // truncates the path it was handed and nothing else.
  const saved = process.env.HYDRA_LOG
  afterEach(() => {
    if (saved === undefined) delete process.env.HYDRA_LOG
    else process.env.HYDRA_LOG = saved
  })

  test('does nothing when HYDRA_LOG is unset — never guesses a path to truncate', () => {
    delete process.env.HYDRA_LOG
    const p = tmpFile('untouched.log')
    writeFileSync(p, 'keep me\n')

    expect(() => trimDaemonLog()).not.toThrow()

    expect(readFileSync(p, 'utf8')).toBe('keep me\n')
  })

  test('does not throw when HYDRA_LOG points at a file that does not exist', () => {
    process.env.HYDRA_LOG = join(tmp, 'no-such-daemon.log')
    expect(() => trimDaemonLog()).not.toThrow()
  })

  test('leaves an under-cap daemon log alone', () => {
    const p = tmpFile('small-daemon.log')
    writeFileSync(p, 'a'.repeat(1024) + '\n')
    process.env.HYDRA_LOG = p
    const before = statSync(p).size

    trimDaemonLog()

    expect(statSync(p).size).toBe(before)
  })
})

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

  test('shows resume count when > 0', () => {
    const out = buildAutopsy(fakeInfo(), 'critic exited (auto-resuming)', [], NOW, undefined, { resumeCount: 3 })
    expect(out.includes('resume #3 of conversation')).toBe(true)
  })

  test('omits resume count when 0', () => {
    const out = buildAutopsy(fakeInfo(), 'critic exited (auto-resuming)', [], NOW, undefined, { resumeCount: 0 })
    expect(out.includes('resume #')).toBe(false)
  })

  test('omits resume count when not provided', () => {
    const out = buildAutopsy(fakeInfo(), 'crashed', [], NOW, undefined)
    expect(out.includes('resume #')).toBe(false)
  })

  test('renders protocol context when provided', () => {
    const pctx = { protocol: 'review', phase: 'critic_turn', round: '1/3', advanceCalled: false, role: 'critic' }
    const out = buildAutopsy(fakeInfo(), 'crashed', [], NOW, undefined, { protocolContext: pctx })
    expect(out.includes('protocol: review (critic_turn, round 1/3)')).toBe(true)
    expect(out.includes('role: critic, advance called: false')).toBe(true)
  })

  test('renders both protocol context and resume count together', () => {
    const pctx = { protocol: 'review', phase: 'critic_turn', round: '1/3', advanceCalled: true, role: 'critic' }
    const out = buildAutopsy(fakeInfo(), 'critic exited', [], NOW, undefined, { protocolContext: pctx, resumeCount: 5 })
    expect(out.includes('protocol: review')).toBe(true)
    expect(out.includes('resume #5 of conversation')).toBe(true)
  })
})

describe('nextResumeCount (doSpawnSession resume lookup)', () => {
  test('first resume of a conversation returns 1', () => {
    const sessions = [
      fakeInfo({ sessionId: 'A', claudeSessionId: 'conv-1', deadAt: NOW - 1000 }),
    ]
    expect(nextResumeCount(sessions, 'conv-1')).toBe(1)
  })

  test('second resume climbs to 2 (not pinned at 1)', () => {
    const sessions = [
      fakeInfo({ sessionId: 'A', claudeSessionId: 'conv-1', deadAt: NOW - 2000 }),
      fakeInfo({ sessionId: 'B', claudeSessionId: 'conv-1', deadAt: NOW - 1000, resumeCount: 1 }),
    ]
    expect(nextResumeCount(sessions, 'conv-1')).toBe(2)
  })

  test('fifth resume reaches 5', () => {
    const sessions = [
      fakeInfo({ sessionId: 'A', claudeSessionId: 'conv-1', deadAt: NOW - 5000 }),
      fakeInfo({ sessionId: 'B', claudeSessionId: 'conv-1', deadAt: NOW - 4000, resumeCount: 1 }),
      fakeInfo({ sessionId: 'C', claudeSessionId: 'conv-1', deadAt: NOW - 3000, resumeCount: 2 }),
      fakeInfo({ sessionId: 'D', claudeSessionId: 'conv-1', deadAt: NOW - 2000, resumeCount: 3 }),
      fakeInfo({ sessionId: 'E', claudeSessionId: 'conv-1', deadAt: NOW - 1000, resumeCount: 4 }),
    ]
    expect(nextResumeCount(sessions, 'conv-1')).toBe(5)
  })

  test('picks most recent dead session when multiple share the conversation id', () => {
    const sessions = [
      fakeInfo({ sessionId: 'A', claudeSessionId: 'conv-1', deadAt: NOW - 3000 }),
      fakeInfo({ sessionId: 'B', claudeSessionId: 'conv-1', deadAt: NOW - 1000, resumeCount: 1 }),
      fakeInfo({ sessionId: 'C', claudeSessionId: 'conv-1', deadAt: NOW - 2000, resumeCount: 99 }),
    ]
    // B is most recent → should use B's count (1), not C's (99)
    expect(nextResumeCount(sessions, 'conv-1')).toBe(2)
  })

  test('ignores live sessions (no deadAt)', () => {
    const sessions = [
      fakeInfo({ sessionId: 'live', claudeSessionId: 'conv-1', resumeCount: 10 }),
    ]
    expect(nextResumeCount(sessions, 'conv-1')).toBe(0)
  })

  test('returns 0 when no matching conversation exists', () => {
    const sessions = [
      fakeInfo({ sessionId: 'A', claudeSessionId: 'conv-other', deadAt: NOW - 1000 }),
    ]
    expect(nextResumeCount(sessions, 'conv-1')).toBe(0)
  })
})

describe('readConversationForensics', () => {
  const TAIL_BYTES = 32 * 1024

  function line(entry: unknown): string {
    return JSON.stringify(entry) + '\n'
  }

  test('extracts full last-assistant text, its timestamp, and turn-completeness', () => {
    const path = tmpFile('forensics-basic.jsonl')
    const ts = '2026-09-21T21:10:00.000Z'
    writeFileSync(path, line({
      type: 'assistant',
      timestamp: ts,
      message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'the real answer, quite long and not truncated at all really' }] },
    }))
    const f = readConversationForensics(path)
    expect(f?.lastAssistantFullText).toBe('the real answer, quite long and not truncated at all really')
    expect(f?.lastAssistantTs).toBe(ts)
    expect(f?.lastAssistantTurnComplete).toBe(true)
    expect(f?.lastToolPending).toBe(false)
  })

  test('marks the turn incomplete when the text block is followed by an unanswered tool_use', () => {
    const path = tmpFile('forensics-midturn.jsonl')
    writeFileSync(path, line({
      type: 'assistant',
      timestamp: '2026-09-21T21:10:00.000Z',
      message: {
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: 'Let me check that...' },
          { type: 'tool_use', id: 'tool-1', name: 'Bash' },
        ],
      },
    }))
    const f = readConversationForensics(path)
    expect(f?.lastAssistantFullText).toBe('Let me check that...')
    expect(f?.lastAssistantTurnComplete).toBe(false)
    expect(f?.lastToolPending).toBe(true)
  })

  // Regression test for a real bug found in adversarial review: a tail read
  // can start mid-line, so the old code unconditionally dropped the first
  // line of the tail as "presumably partial" — but when the read offset
  // happens to land exactly on a line boundary, that first line is actually
  // complete and valid, and blindly dropping it silently loses real content
  // (here, the very answer this function exists to find).
  test('keeps a complete line even when the tail cut lands exactly on a line boundary', () => {
    const path = tmpFile('forensics-boundary.jsonl')
    const marker = { type: 'assistant', timestamp: '2026-09-21T21:10:00.000Z', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'MARKER: must survive the tail cut' }] } }
    const markerLine = line(marker)
    const markerBytes = Buffer.byteLength(markerLine, 'utf8')
    const before = line({ type: 'other', pad: 'x'.repeat(200) }) // arbitrary content before the boundary
    const afterBytes = TAIL_BYTES - markerBytes
    const after = 'x'.repeat(Math.max(0, afterBytes - 1)) + '\n' // invalid JSON — parsed and skipped, just padding
    writeFileSync(path, before + markerLine + after)

    const stat = statSync(path)
    const offset = stat.size - TAIL_BYTES
    // Sanity-check the fixture actually exercises the boundary case before
    // trusting the assertion below.
    expect(offset).toBe(Buffer.byteLength(before, 'utf8'))

    const f = readConversationForensics(path)
    expect(f?.lastAssistantFullText).toBe('MARKER: must survive the tail cut')
    expect(f?.isTail).toBe(true)
  })
  test('queue backlog: enqueue without dequeue is outstanding; FIFO dequeues drain it; lastConsumeTs is the latest', () => {
    const path = tmpFile('forensics-queue.jsonl')
    const op = (operation: string, timestamp: string) => line({ type: 'queue-operation', operation, timestamp })
    writeFileSync(path, op('enqueue', 'T1') + op('dequeue', 'T2') + op('enqueue', 'T3') + op('enqueue', 'T4') + op('dequeue', 'T5'))
    const f = readConversationForensics(path)
    expect(f?.queueBacklog).toBe(1)
    expect(f?.lastConsumeTs).toBe('T5')
  })

  test('queue backlog: a remove (message injected into the running turn) consumes like a dequeue', () => {
    const path = tmpFile('forensics-queue-remove.jsonl')
    const op = (operation: string, timestamp: string) => line({ type: 'queue-operation', operation, timestamp })
    writeFileSync(path, op('enqueue', 'T1') + op('remove', 'T2'))
    const f = readConversationForensics(path)
    expect(f?.queueBacklog).toBe(0)
    expect(f?.lastConsumeTs).toBe('T2')
  })

  test('queue backlog: a consume record without a timestamp does not erase the last known consume time', () => {
    const path = tmpFile('forensics-queue-nots.jsonl')
    writeFileSync(path, line({ type: 'queue-operation', operation: 'enqueue', timestamp: 'T1' }) + line({ type: 'queue-operation', operation: 'dequeue', timestamp: 'T2' })
      + line({ type: 'queue-operation', operation: 'enqueue', timestamp: 'T3' }) + line({ type: 'queue-operation', operation: 'remove' }))
    const f = readConversationForensics(path)
    expect(f?.queueBacklog).toBe(0)
    expect(f?.lastConsumeTs).toBe('T2')
  })

  test('queue backlog: a dequeue whose enqueue is outside the tail clamps at 0; no ops -> 0/null', () => {
    const path = tmpFile('forensics-queue-clamp.jsonl')
    writeFileSync(path, line({ type: 'queue-operation', operation: 'dequeue', timestamp: 'T9' }))
    expect(readConversationForensics(path)?.queueBacklog).toBe(0)
    const none = tmpFile('forensics-queue-none.jsonl')
    writeFileSync(none, line({ type: 'other' }))
    const f = readConversationForensics(none)
    expect(f?.queueBacklog).toBe(0)
    expect(f?.lastConsumeTs).toBeNull()
  })
})

// T6 (adapter-policy): the reply guard's turn-outcome composition (F1s/F2s).
describe('turnOutcome composition', () => {
  const T = 1_000_000_000
  const iso = (ms: number) => new Date(ms).toISOString()
  const forensics = (over: Partial<ConversationForensics> = {}): ConversationForensics => ({
    tailTurns: 1, lastStopReason: 'end_turn', lastToolCalled: null, lastToolPending: false,
    pendingToolCount: 0, tailApiCalls: 1, lastAssistantText: null, isTail: false,
    lastAssistantFullText: null, lastAssistantTs: null, lastAssistantTurnComplete: true,
    queueBacklog: 0, lastConsumeTs: null, ...over,
  })
  // Production shape: transcript at claude-abc; the codex maps hold a fresh message.
  function src(over: { flag?: boolean; f?: ConversationForensics | null; msgAt?: number } = {}): TurnSources {
    const f = 'f' in over ? over.f ?? null : forensics({ lastAssistantFullText: 'transcript answer', lastAssistantTs: iso(T + 5000) })
    return {
      transcriptPathFor: (id) => id === 'claude-abc' ? '/t.jsonl' : undefined,
      readConversationForensics: (p) => p === '/t.jsonl' ? f : null,
      getLastCodexMessage: (sid, since) => sid === 's1' && (over.msgAt ?? T + 1000) >= since ? 'codex answer' : null,
      isCodexTurnComplete: (sid) => sid === 's1' && (over.flag ?? false),
    }
  }
  const codex = { sessionId: 's1', engine: 'codex' } as SessionInfo
  const claude = { sessionId: 's1', engine: 'claude', claudeSessionId: 'claude-abc' } as SessionInfo
  const codexFn = codexTurnOutcome
  const claudeFns = [codexTurnOutcome, claudeTurnOutcome]

  test('PINNED R9: Codex record holding claudeSessionId relays the transcript', () => {
    const o = codexFn({ ...codex, claudeSessionId: 'claude-abc' }, T, src({ flag: true }))
    expect(o.confirmedComplete).toBe(true)
    expect(o.answer()).toBe('transcript answer')
  })

  test('PINNED R9: empty transcript does not fall through to the codex message', () => {
    expect(codexFn({ ...codex, claudeSessionId: 'claude-abc' }, T, src({ flag: true, f: forensics() })).answer()).toBeNull()
    expect(codexFn({ ...codex, claudeSessionId: 'claude-abc' }, T, src({ flag: true, f: null })).answer()).toBeNull()
  })

  test('PINNED R15: a stale flag from the previous turn confirms completion (skips grace)', () => {
    // flag still true from the last turn; no message since this delivery
    const o = codexFn(codex, T, src({ flag: true, msgAt: T - 60_000 }))
    expect(o.confirmedComplete).toBe(true)
    expect(o.answer()).toBeNull()
  })

  test('Codex: flag set → confirmed, relays the fresh message', () => {
    const o = codexFn(codex, T, src({ flag: true }))
    expect(o.confirmedComplete).toBe(true)
    expect(o.answer()).toBe('codex answer')
  })

  test('Codex: flag unset → not confirmed, no relay even with a fresh message', () => {
    const o = codexFn(codex, T, src({ flag: false }))
    expect(o.confirmedComplete).toBe(false)
    expect(o.answer()).toBeNull()
  })

  test('Codex: message text comes from getLastCodexMessage(sessionId, since)', () => {
    const seen: Array<[string, number]> = []
    const s = { ...src({ flag: true }), getLastCodexMessage: (sid: string, since: number) => { seen.push([sid, since]); return 'exact text' } }
    expect(codexFn(codex, T, s).answer()).toBe('exact text')
    expect(seen).toEqual([['s1', T]])
  })

  for (const [i, fn] of claudeFns.entries()) {
    test(`Claude[${i}]: complete, fresh transcript → relayed; never confirmed`, () => {
      const o = fn(claude, T, src())
      expect(o.confirmedComplete).toBe(false)
      expect(o.answer()).toBe('transcript answer')
    })

    test(`Claude[${i}]: incomplete or stale transcript → null`, () => {
      expect(fn(claude, T, src({ f: forensics({ lastAssistantFullText: 'Let me check', lastAssistantTs: iso(T + 5000), lastAssistantTurnComplete: false }) })).answer()).toBeNull()
      expect(fn(claude, T, src({ f: forensics({ lastAssistantFullText: 'Let me check', lastAssistantTs: iso(T + 5000), lastToolPending: true }) })).answer()).toBeNull()
      expect(fn(claude, T, src({ f: forensics({ lastAssistantFullText: 'old', lastAssistantTs: iso(T - 5000) }) })).answer()).toBeNull()
    })

    test(`Claude[${i}]: no transcript, or no claudeSessionId → null`, () => {
      expect(fn(claude, T, src({ f: null })).answer()).toBeNull()
      expect(fn({ ...claude, claudeSessionId: 'claude-other' }, T, src()).answer()).toBeNull()
      expect(fn({ ...claude, claudeSessionId: undefined }, T, src()).answer()).toBeNull()
    })
  }

  // Claude turn end from the live status file (status idle + this message taken up + answer after the last dequeue).
  describe('claudeTurnOutcome: live status', () => {
    const live = { ...claude, tmuxName: 'cedar' } as SessionInfo
    // A consume in view (T+1000) before the answer (T+5000): the state of a normally delivered message.
    const base = () => forensics({ lastAssistantFullText: 'transcript answer', lastAssistantTs: iso(T + 5000), lastConsumeTs: iso(T + 1000) })
    const withStatus = (status: { sessionId: string; status: string } | null, f?: ConversationForensics | null): TurnSources =>
      ({ ...src({ f: f === undefined ? base() : f }), readClaudeStatus: (n: string) => n === 'cedar' ? status : null })
    const idle = { sessionId: 'claude-abc', status: 'idle' }

    test('idle + fresh answer + nothing queued → confirmed, answer relayed', () => {
      const o = claudeTurnOutcome(live, T, withStatus(idle))
      expect(o.confirmedComplete).toBe(true)
      expect(o.answer()).toBe('transcript answer')
    })
    test('busy, waiting, or unreadable status → not confirmed', () => {
      expect(claudeTurnOutcome(live, T, withStatus({ ...idle, status: 'busy' })).confirmedComplete).toBe(false)
      expect(claudeTurnOutcome(live, T, withStatus({ ...idle, status: 'waiting' })).confirmedComplete).toBe(false)
      expect(claudeTurnOutcome(live, T, withStatus(null)).confirmedComplete).toBe(false)
      expect(claudeTurnOutcome(claude, T, withStatus(idle)).confirmedComplete).toBe(false) // no tmuxName
    })
    test('a message still queued behind a running turn → not confirmed', () => {
      const f = forensics({ lastAssistantFullText: 'turn A answer', lastAssistantTs: iso(T + 5000), queueBacklog: 1 })
      expect(claudeTurnOutcome(live, T, withStatus(idle, f)).confirmedComplete).toBe(false)
    })
    test('an answer written before the last dequeue belongs to an earlier turn → not confirmed', () => {
      const f = forensics({ lastAssistantFullText: 'turn A answer', lastAssistantTs: iso(T + 5000), lastConsumeTs: iso(T + 6000) })
      expect(claudeTurnOutcome(live, T, withStatus(idle, f)).confirmedComplete).toBe(false)
      const g = forensics({ lastAssistantFullText: 'turn B answer', lastAssistantTs: iso(T + 7000), lastConsumeTs: iso(T + 6000) })
      expect(claudeTurnOutcome(live, T, withStatus(idle, g)).confirmedComplete).toBe(true)
    })
    test('idle but no usable answer (tool pending, stale, no transcript) → not confirmed', () => {
      expect(claudeTurnOutcome(live, T, withStatus(idle, forensics({ lastAssistantFullText: 'Let me check', lastAssistantTs: iso(T + 5000), lastToolPending: true }))).confirmedComplete).toBe(false)
      expect(claudeTurnOutcome(live, T, withStatus(idle, forensics({ lastAssistantFullText: 'old', lastAssistantTs: iso(T - 5000) }))).confirmedComplete).toBe(false)
      expect(claudeTurnOutcome(live, T, withStatus(idle, null)).confirmedComplete).toBe(false)
    })
    test('tail read with no consume in view (enqueue may be cut off) → not confirmed', () => {
      const f = forensics({ lastAssistantFullText: 'answer to A, not M', lastAssistantTs: iso(T + 5000), isTail: true })
      expect(claudeTurnOutcome(live, T, withStatus(idle, f)).confirmedComplete).toBe(false)
    })
    test('no consume record at all (log format drift, or a first message) → not confirmed, even on a full read', () => {
      const f = forensics({ lastAssistantFullText: 'answer', lastAssistantTs: iso(T + 5000), isTail: false })
      expect(claudeTurnOutcome(live, T, withStatus(idle, f)).confirmedComplete).toBe(false)
      expect(claudeTurnOutcome(live, T, withStatus(idle, { ...f, lastConsumeTs: iso(T + 1000) })).confirmedComplete).toBe(true)
    })
    test('the transcript is the one the status file names, not the registry pin (follows /clear)', () => {
      const seen: string[] = []
      const s = { ...withStatus({ sessionId: 'claude-new', status: 'idle' }), transcriptPathFor: (id: string) => { seen.push(id); return '/t.jsonl' } }
      expect(claudeTurnOutcome(live, T, s).answer()).toBe('transcript answer')
      expect(seen).toEqual(['claude-new'])
    })
    test('one snapshot: confirmedComplete and answer() agree even if the status file changes, one transcript read', () => {
      let statusReads = 0, forensicsReads = 0
      const ids: string[] = []
      const s = {
        ...withStatus(idle),
        readClaudeStatus: () => ++statusReads === 1 ? idle : { sessionId: 'claude-other', status: 'busy' },
        transcriptPathFor: (id: string) => { ids.push(id); return '/t.jsonl' },
        readConversationForensics: () => { forensicsReads++; return forensics({ lastAssistantFullText: 'answer', lastAssistantTs: iso(T + 5000), lastConsumeTs: iso(T + 1000) }) },
      }
      const o = claudeTurnOutcome(live, T, s)
      expect(o.confirmedComplete).toBe(true)
      expect(o.answer()).toBe('answer')
      expect(o.confirmedComplete).toBe(true)
      expect({ statusReads, forensicsReads, ids }).toEqual({ statusReads: 1, forensicsReads: 1, ids: ['claude-abc'] })
    })
    test('lazy: no status read until confirmedComplete or answer is asked for', () => {
      let reads = 0
      const s = { ...withStatus(idle), readClaudeStatus: () => { reads++; return idle } }
      const o = claudeTurnOutcome(live, T, s)
      expect(reads).toBe(0)
      void o.confirmedComplete
      expect(reads).toBe(1)
    })
  })

  // S6 exit: adapters delegate through defaultTurnSources — swapping its members
  // gives exactly what the exported function returns over the swapped sources.
  test('delegation: adapters answer as their exported function over swapped defaultTurnSources', () => {
    const saved = { ...defaultTurnSources }
    const swapped = src({ flag: true })
    Object.assign(defaultTurnSources, swapped)
    try {
      const infos = [codex, { ...codex, claudeSessionId: 'claude-abc' }, claude, { ...claude, claudeSessionId: undefined }]
      for (const [provider, fn] of [['claude', claudeTurnOutcome], ['codex', codexTurnOutcome]] as const) {
        for (const info of infos) {
          const a = engines[provider].turn(info, T), b = fn(info, T, swapped)
          expect({ c: a.confirmedComplete, t: a.answer() }).toEqual({ c: b.confirmedComplete, t: b.answer() })
        }
      }
      // the swap is visible (not both reading the live, empty sources)
      expect(engines.codex.turn(codex, T).answer()).toBe('codex answer')
      expect(engines.claude.turn(claude, T).answer()).toBe('transcript answer')
    } finally { Object.assign(defaultTurnSources, saved) }
  })

  // answer() stays lazy: turn() reads no transcript or Codex message until asked.
  // The poller builds turn() every 20s per pending session just for activityAt: no status/transcript reads then.
  test('claude adapter: turn().activityAt reads no status file; confirmedComplete does', () => {
    const saved = { ...defaultTurnSources }
    let statusReads = 0
    Object.assign(defaultTurnSources, { ...src(), readClaudeStatus: () => { statusReads++; return null } })
    try {
      const t = engines.claude.turn({ ...claude, tmuxName: 'cedar' } as SessionInfo, T)
      void t.activityAt
      expect(statusReads).toBe(0)
      void t.confirmedComplete
      expect(statusReads).toBe(1)
    } finally { Object.assign(defaultTurnSources, saved) }
  })

  test('adapters: turn() reads nothing until answer() is called', () => {
    const saved = { ...defaultTurnSources }
    let reads = 0
    Object.assign(defaultTurnSources, {
      ...src({ flag: true }),
      readConversationForensics: () => { reads++; return null },
      getLastCodexMessage: () => { reads++; return null },
    })
    try {
      for (const [provider, info] of [['claude', claude], ['codex', claude], ['codex', codex]] as const) {
        reads = 0
        const t = engines[provider].turn(info, T)
        expect(reads).toBe(0)
        t.answer()
        expect(reads).toBe(1)
      }
    } finally { Object.assign(defaultTurnSources, saved) }
  })
})

// Review of P6–S6: the reply guard's default routing and Claude never confirming.
describe('defaultTurnOutcome routing', () => {
  const T = Date.now()
  test('Codex adapter: live-source Codex composition (flag set → confirmed, Codex text)', async () => {
    const { defaultTurnOutcome } = await import('../reply-guard.js')
    const saved = { ...defaultTurnSources }
    Object.assign(defaultTurnSources, {
      isCodexTurnComplete: () => true,
      getLastCodexMessage: () => 'codex text',
      transcriptPathFor: () => undefined,
      readConversationForensics: () => null,
    })
    try {
      const o = defaultTurnOutcome({ sessionId: 'nx', engine: 'codex', adapter: engines.codex } as SessionInfo, T)
      expect(o.confirmedComplete).toBe(true)
      expect(o.answer()).toBe('codex text')
    } finally { Object.assign(defaultTurnSources, saved) }
  })

  test('with an adapter: routed to the adapter', async () => {
    const { defaultTurnOutcome } = await import('../reply-guard.js')
    const answer = { confirmedComplete: true, answer: () => 'from adapter' }
    const o = defaultTurnOutcome({ sessionId: 'a', engine: 'claude', adapter: { turn: () => answer } } as any, T)
    expect(o).toBe(answer)
  })

  test('claudeTurnOutcome never confirms, even with the Codex flag set', () => {
    const src: TurnSources = {
      transcriptPathFor: () => '/t.jsonl', readConversationForensics: () => null,
      getLastCodexMessage: () => null, isCodexTurnComplete: () => true,
    }
    expect(claudeTurnOutcome({ sessionId: 's1', engine: 'claude', claudeSessionId: 'c' } as SessionInfo, T, src).confirmedComplete).toBe(false)
  })
})
