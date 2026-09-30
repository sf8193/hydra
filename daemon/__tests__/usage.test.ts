import { describe, test, expect, afterEach, beforeEach } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, appendFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { homedir, tmpdir } from 'os'
import { basename, dirname, join, sep } from 'path'
import { drainSession, drainUsage, latestCwd, newCursor, newSessionCursor, projectDirName, projectDirNames, projectsRoot, readUsageDelta, subagentPathsFor, sumTotals, turnsIn, totalsChanged, transcriptPathFor, zeroPhaseTotals, zeroTotals } from '../usage.js'
import { USAGE_PHASES } from '../usage-phase.js'
import { healSubagent, plantBrokenListing, plantSubagent, plantTranscript, plantUnreadableSubagent, subagentsDirOf, turnLines, uniqueClaudeId } from './projects-fixture.js'
import { claudeConfigDir } from '../../shared/constants.js'
import { TEST_STATE_DIR } from '../../test-setup.js'
import { buildEvent } from '../raindrop-payload.js'

const line = (usage: Record<string, number>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ ...extra, message: { role: 'assistant', usage } }) + '\n'

const fixtureDirs: string[] = []
afterEach(() => {
  while (fixtureDirs.length) { try { rmSync(fixtureDirs.pop()!, { recursive: true, force: true }) } catch {} }
})

function fixture(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'usage-'))
  fixtureDirs.push(dir)
  const f = join(dir, 't.jsonl')
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
    [9.7, 9],
  ] as const)('a counter of %p contributes %p', (raw, want) => {
    const f = fixture(JSON.stringify({ message: { usage: { output_tokens: raw } } }) + '\n')
    expect(readUsageDelta(f, newCursor()).totals.outputTokens).toBe(want)
  })

  // Written as raw JSON, not via JSON.stringify: stringify turns Infinity into
  // null, so routing it through the object form never reaches the finite check.
  // A negative passes typeof/isFinite, and would walk the cumulative gauge
  // backwards and put a negative into a windowed SUM.
  test.each(['-1000', '-1'])('a negative counter of %s contributes 0', (literal) => {
    const f = fixture(`{"message":{"usage":{"output_tokens":${literal}}}}\n`)
    expect(readUsageDelta(f, newCursor()).totals.outputTokens).toBe(0)
  })

  test.each(['1e999', '-1e999'])('a counter of %s parses to Infinity and contributes 0', (literal) => {
    const f = fixture(`{"message":{"usage":{"output_tokens":${literal}}}}\n`)
    expect(readUsageDelta(f, newCursor()).totals.outputTokens).toBe(0)
  })

  // A partial line smaller than the window must NOT advance the cursor — the
  // turn is still being written and its counters land on the next read.
  test('a trailing partial line under the window is waited for, not skipped', () => {
    const complete = JSON.stringify({ message: { id: 'a', usage: { output_tokens: 9 } } }) + '\n'
    const f = fixture(complete.slice(0, -12))
    const first = readUsageDelta(f, newCursor())
    expect(first.offset, 'nothing complete yet, so nothing consumed').toBe(0)
    expect(first.totals.outputTokens).toBe(0)
    writeFileSync(f, complete)
    expect(readUsageDelta(f, first).totals.outputTokens, 'the turn lands once it completes').toBe(9)
  })

  // Silence here meant a session reporting zero spend for the daemon's life:
  // not in `unresolved`, no counter, and a status line reading healthy.
  test('a vanished transcript throws so the tick can count it', () => {
    expect(() => readUsageDelta('/nope/absent.jsonl', newCursor())).toThrow()
  })

  // stat succeeds and open fails — a file locked or swapped under the tick.
  // Accounting must be loud about it; attribution only costs a repo name.
  test('an unreadable transcript throws for usage and degrades for cwd', () => {
    const f = fixture(line({ output_tokens: 3 }))
    if (process.getuid?.() === 0) return
    chmodSync(f, 0o000)
    try {
      expect(() => readUsageDelta(f, newCursor())).toThrow()
      expect(() => latestCwd(f)).not.toThrow()
      expect(latestCwd(f)).toBeUndefined()
    } finally { chmodSync(f, 0o600) }
  })
})

describe('usage: nothing but integers can escape', () => {
  // This reads the directory that holds conversation content. Asserting on
  // `.totals` alone proved nothing — it is four numbers by construction, so no
  // mutation could fail it. The cursor is what the reader actually hands back.
  const SECRETS = ['123-45-6789', 'wire $2.4M to Acme Corp', 'kevin@example.com', '/Users/kevin/secret-repo']
  const planted = () => fixture(
    JSON.stringify({
      cwd: '/Users/kevin/secret-repo',
      message: {
        role: 'assistant', id: `msg_${SECRETS[0]}`, usage: { output_tokens: 3 },
        // A real tool_use block, so the classifier actually RUNS against
        // attacker-controlled text. With a bare string here toolNamesFrom
        // returned [], no phase was ever chosen, and the guards below asserted
        // nothing — a classifier that lifted its input passed both.
        content: [{ type: 'tool_use', name: `mcp__${SECRETS[1]}__reply`, input: { prompt: SECRETS.join(' ') } }],
      },
      summary: SECRETS.join(' | '),
    }) + '\n',
  )

  // The cursor is memory-only. Two of its strings are lifted from the file and
  // one (latch) is derived; if any is ever widened onto SessionUsage, this is
  // what has to be revisited.
  test('the cursor holds transcript text, and exactly three string fields', () => {
    const cursor = readUsageDelta(planted(), newCursor())
    expect(cursor.lastMessageId, 'the id comes straight off the line').toContain(SECRETS[0])
    expect(Object.keys(cursor).filter(k => typeof (cursor as Record<string, unknown>)[k] === 'string').sort())
      .toEqual(['lastMessageId', 'latch', 'path'])
  })

  // latch is the third string. The fixture's tool name is attacker-controlled
  // and DOES drive the classifier, so this pins that the cursor keeps the set
  // member rather than the name that selected it.
  test('the phase is drawn from its own closed set, not from the transcript', () => {
    const cursor = readUsageDelta(planted(), newCursor())
    // The measurement, not a tautology: the planted reply tool routed the spend
    // to `report` while leaving the latch where it was. Asserting membership or
    // secret-absence beside an exact match would restate this one, not test it.
    expect(cursor.phaseTotals.report.outputTokens).toBe(3)
    expect(cursor.latch, 'replying is momentary — the latch must not follow it').toBe('plan')
  })

  // What actually matters: the wire. An earlier version of this test built
  // `extra` from two numbers and a literal, so it asserted that strings nobody
  // supplied were absent — deleting every egress gate left it green. Now the
  // cursor's own transcript-derived strings are what gets handed to buildEvent,
  // through the two keys most likely to carry one.
  test('transcript text handed to the payload does not survive into the body', () => {
    const cursor = readUsageDelta(planted(), newCursor())
    const body = buildEvent({
      event: 'hydra.session.usage',
      eventId: 'e', userId: 'U056CLXJY8P', threadId: 'T', at: 1789752921748, omitRepo: false,
      facts: {
        threadId: 'T', createdAt: 0, tmuxName: 'atlas', engine: 'claude',
        sessionType: 'thread_owner', platform: 'slack',
        project: 'hydra', label: SECRETS[1],
      },
      extra: {
        cumulativeOutputTokens: cursor.totals.outputTokens,
        deltaOutputTokens: cursor.totals.outputTokens,
        claudeSessionId: cursor.lastMessageId!,
        reason: cursor.path!,
        summary: SECRETS.join(' '),
        // Charset-clean, so only the KEY allowlist can stop this one.
        cwdBasename: 'secret-repo',
      },
    })
    const serialized = JSON.stringify(body)
    for (const secret of [...SECRETS, cursor.lastMessageId!, cursor.path!, 'secret-repo']) {
      expect(serialized, `leaked ${secret}`).not.toContain(secret)
    }
    expect(body!.properties.cumulativeOutputTokens, 'and the counter still got through').toBe(3)
  })
})

describe('usage: one turn, many content blocks', () => {
  const env = { input_tokens: 2, output_tokens: 336, cache_creation_input_tokens: 25682, cache_read_input_tokens: 13729 }
  const block = (id: string) => JSON.stringify({ message: { id, role: 'assistant', usage: env } }) + '\n'

  // Claude writes one line per content block and repeats the whole usage
  // envelope on each. Summing every line inflated the fleet 2.5x on output.
  test('repeated blocks of one turn count once, not once per block', () => {
    const c = readUsageDelta(fixture(block('msg_a') + block('msg_a') + block('msg_a')), newCursor())
    expect(c.totals.outputTokens).toBe(336)
    expect(c.totals.cacheReadTokens).toBe(13729)
  })

  test('genuinely distinct turns both count', () => {
    const c = readUsageDelta(fixture(block('msg_a') + block('msg_b')), newCursor())
    expect(c.totals.outputTokens).toBe(672)
  })

  test('a turn whose blocks straddle two reads still counts once', () => {
    const f = fixture(block('msg_a'))
    const first = readUsageDelta(f, newCursor())
    expect(first.totals.outputTokens).toBe(336)
    appendFileSync(f, block('msg_a'))
    const second = readUsageDelta(f, first)
    expect(second.totals.outputTokens, 'the id must survive on the cursor').toBe(336)
    appendFileSync(f, block('msg_b'))
    expect(readUsageDelta(f, second).totals.outputTokens).toBe(672)
  })

  test('a re-read from the top does not carry a stale id across the reset', () => {
    const f = fixture(block('msg_a'))
    const c = readUsageDelta(f, { offset: 9_999, totals: { inputTokens: 5, outputTokens: 5, cacheCreateTokens: 5, cacheReadTokens: 5 }, lastMessageId: 'msg_a', latch: 'review', phaseTotals: zeroPhaseTotals(), voted: [] })
    expect(c.totals.outputTokens, 'the rotated file must be counted afresh').toBe(336)
  })
})

describe('usage: offsets are counted in bytes', () => {
  // Every other fixture is ASCII, where a byte offset and a character offset
  // agree. A transcript is full of emoji and box-drawing, and a short offset
  // restarts the next read inside lines already counted.
  const wide = (n: number) => line({ output_tokens: n }, { note: '🚀 é 中 ——' })

  test('a multi-byte transcript read in two passes counts each turn once', () => {
    const f = fixture(wide(3).repeat(20))
    const first = readUsageDelta(f, newCursor())
    expect(first.offset, 'the offset must be in bytes, not characters').toBe(statSync(f).size)
    expect(first.totals.outputTokens).toBe(60)
    appendFileSync(f, wide(7))
    expect(readUsageDelta(f, first).totals.outputTokens, 'no turn may be re-counted').toBe(67)
  })

  test('a multi-byte transcript drained in small windows totals the same as one pass', () => {
    const body = wide(3).repeat(20)
    const whole = readUsageDelta(fixture(body), newCursor())
    const f = fixture(body)
    let c = newCursor(), prev = -1
    while (c.offset !== prev) { prev = c.offset; c = readUsageDelta(f, c, 300) }
    expect(c.totals.outputTokens, 'chunked must equal single-pass').toBe(whole.totals.outputTokens)
    expect(c.totals.outputTokens, 'and must equal the arithmetic truth').toBe(60)
    expect(c.offset).toBe(statSync(f).size)
  })
})

describe('usage: the cursor belongs to one transcript', () => {
  // claudeSessionId is reassigned in place on a live registry entry, so the
  // same cursor can be handed a different file. Applying the old offset read
  // the new transcript from a meaningless byte and kept the old totals.
  // The replacement must be LARGER than the old offset, or the pre-existing
  // size<offset rotation masks the bug: that is the case that read a different
  // transcript from a meaningless byte and added it to the old totals.
  test('a cursor built against a shorter file does not resume mid-way into a longer one', () => {
    const a = fixture(line({ output_tokens: 100 }))
    const b = fixture(line({ output_tokens: 7 }).repeat(40))
    const ca = readUsageDelta(a, newCursor())
    expect(ca.totals.outputTokens).toBe(100)
    expect(ca.offset).toBeLessThan(statSync(b).size)
    expect(readUsageDelta(b, ca).totals.outputTokens, 'b must be read whole, not from the old offset').toBe(280)
  })

  // Stalling here stopped the session reporting for the daemon's whole life.
  test('a line longer than the read window does not stall the cursor forever', () => {
    const fat = JSON.stringify({ message: { id: 'fat', usage: { output_tokens: 1 }, pad: 'x'.repeat(4000) } }) + '\n'
    const f = fixture(fat + line({ output_tokens: 7 }))
    let c = readUsageDelta(f, newCursor(), 1024)
    let prev = -1, ticks = 0
    while (c.offset !== prev && ticks < 30) { prev = c.offset; c = readUsageDelta(f, c, 1024); ticks++ }
    expect(c.offset, 'the cursor must step past the oversized line').toBeGreaterThan(0)
    expect(c.totals.outputTokens, 'and still pick up the line after it').toBe(7)
  })
})

describe('usage: totalsChanged', () => {
  test.each(['inputTokens', 'outputTokens', 'cacheCreateTokens', 'cacheReadTokens'] as const)(
    'a move in %s alone is detected', (k) => {
      expect(totalsChanged(zeroTotals(), { ...zeroTotals(), [k]: 1 })).toBe(true)
    })

  test.each([zeroTotals(), { inputTokens: 1, outputTokens: 2, cacheCreateTokens: 3, cacheReadTokens: 4 }])(
    'identical totals are not a change', (t) => {
      expect(totalsChanged(t, { ...t })).toBe(false)
    })
})

describe('usage: locating the transcript', () => {
  test.each([
    ['/Users/kevin/RubymineProjects/hydra', '-Users-kevin-RubymineProjects-hydra'],
    ['/Users/kevin/RubymineProjects/.worktrees/hydra-atlas', '-Users-kevin-RubymineProjects--worktrees-hydra-atlas'],
  ])('%p encodes to %p', (cwd, dir) => {
    expect(projectDirName(cwd)).toBe(dir)
  })

  // A fork spawned into a worktree runs at spawnCwd, so its transcript is NOT
  // under a dir derived from the worktree path. Only a scan finds it.
  test('finds a transcript whose directory bears no relation to the session cwd', () => {
    const id = uniqueClaudeId('fork')
    const planted = plantTranscript(id, line({ output_tokens: 1 }))
    try {
      expect(transcriptPathFor(id)).toBe(planted.path)
      expect(planted.dir).not.toContain(projectDirName('/Users/kevin/RubymineProjects/.worktrees/hydra-atlas'))
    } finally { planted.cleanup() }
  })

  // Total, so a session with no transcript still reaches `unresolved` — the
  // count that names CLAUDE_CONFIG_DIR. The root failure is reported separately,
  // once per tick, because it is one fleet-wide condition and not 25.
  test('an unreadable projects root resolves to undefined, and is separately visible', () => {
    const saved = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(tmpdir(), `absent-${randomUUID()}`)
    try {
      expect(transcriptPathFor('anything')).toBeUndefined()
      expect(() => projectDirNames(), 'the tick probes this to name the cause').toThrow()
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = saved
    }
  })

  test('an id with no transcript anywhere resolves to undefined, not a bogus path', () => {
    const decoy = plantTranscript(uniqueClaudeId('decoy'), line({ output_tokens: 1 }))
    // An empty id would otherwise probe for a file literally named '.jsonl'.
    writeFileSync(join(decoy.dir, '.jsonl'), '')
    try {
      expect(transcriptPathFor(uniqueClaudeId('never-written'))).toBeUndefined()
      expect(transcriptPathFor('')).toBeUndefined()
    } finally { decoy.cleanup() }
  })

  // The tail starts mid-line, so its first line never parses. If the LAST line
  // is bigger than the window, the whole tail sits inside it and nothing parses
  // — which pinned the session on repo "none" for a full cache TTL. 193 lines
  // in the live corpus exceed 256KB.
  test('a final line larger than the tail window still yields a cwd', () => {
    const fat = JSON.stringify({ cwd: '/repos/nova', pad: 'x'.repeat(400 * 1024) }) + '\n'
    const f = fixture(JSON.stringify({ cwd: '/repos/old' }) + '\n' + fat)
    expect(statSync(f).size).toBeGreaterThan(256 * 1024)
    expect(latestCwd(f), 'the tail alone cannot parse; it must widen').toBe('/repos/nova')
  })

  // The widen is bounded, not a whole-file read: without the bound this is a
  // synchronous Buffer.alloc(fileSize) once per session per tick.
  test('the widened read is bounded, so a cwd beyond it is not found', () => {
    const fat = JSON.stringify({ cwd: '/repos/nova', pad: 'x'.repeat(4096) }) + '\n'
    const f = fixture(JSON.stringify({ cwd: '/repos/way-back' }) + '\n' + fat)
    expect(latestCwd(f, 64, 5000)).toBe('/repos/nova')
    expect(latestCwd(f, 64, 128), 'the bound must actually stop the read').toBeUndefined()
  })

  test('the default widen is bounded too, not the whole file', () => {
    // cwd only at the very front, then more than the widen window of padding
    const pad = JSON.stringify({ note: 'x'.repeat(512 * 1024) }) + '\n'
    const f = fixture(JSON.stringify({ cwd: '/repos/way-back' }) + '\n' + pad.repeat(20))
    expect(statSync(f).size).toBeGreaterThan(8 * 1024 * 1024)
    expect(latestCwd(f), 'an unbounded widen would find it').toBeUndefined()
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

describe('usage: drainUsage', () => {
  // A 32MB transcript needs five 8MB windows. Stopping after one reported 17%
  // of that session's real spend until the ramp caught up, minutes later.
  test('a transcript spanning many windows totals the same as one pass', () => {
    const body = line({ output_tokens: 3 }).repeat(200)
    const whole = readUsageDelta(fixture(body), newCursor(), 1024 * 1024)
    // A window far smaller than the file, so the loop must run many passes.
    const drained = drainUsage(fixture(body), newCursor(), 256)
    expect(drained.totals.outputTokens).toBe(whole.totals.outputTokens)
    expect(drained.totals.outputTokens).toBe(600)
  })

  // The cap was pinned downward only — raising it to 100000 left the suite
  // green, the same shape as the widen that was proved to happen but not to stop.
  test('the pass cap stops a runaway drain short of EOF, to be resumed next tick', () => {
    const body = line({ output_tokens: 1 }).repeat(200)
    const f = fixture(body)
    // One line per pass, so 200 lines cannot finish inside a 64-pass budget.
    const capped = drainUsage(f, newCursor(), line({ output_tokens: 1 }).length)
    expect(capped.offset, 'the cap must bite before EOF').toBeLessThan(body.length)
    expect(capped.totals.outputTokens).toBe(64)

    // And the next tick picks up exactly where it stopped, losing nothing.
    const resumed = drainUsage(f, capped, line({ output_tokens: 1 }).length)
    expect(resumed.totals.outputTokens).toBe(128)
  })

  // raindrop.ts banks a read's phaseTotals as a long-lived delivered baseline
  // and subtracts the next read from it. If a read handed back the buckets its
  // predecessor still holds, the banked baseline would track the live cursor and
  // every delta would settle at zero — silently, across a file boundary. The
  // adapter copies at that seam too; this is the invariant that makes the copy
  // belt-and-braces rather than load-bearing.
  test('a read never hands back the buckets the cursor it was given holds', () => {
    const f = fixture(line({ output_tokens: 5 }))
    const first = drainUsage(f, newCursor(), 256)
    const banked = first.phaseTotals
    appendFileSync(f, line({ output_tokens: 7 }))
    const second = drainUsage(f, first, 256)
    expect(second.phaseTotals, 'a fresh record, not the one handed in').not.toBe(banked)
    for (const p of USAGE_PHASES) {
      expect(second.phaseTotals[p], `${p}'s bucket is fresh too`).not.toBe(banked[p])
    }
    expect(banked.plan.outputTokens, 'the banked baseline did not move').toBe(5)
    expect(second.phaseTotals.plan.outputTokens).toBe(12)
  })

  test('draining twice with nothing new does not move the cursor or the totals', () => {
    const f = fixture(line({ output_tokens: 5 }).repeat(10))
    const first = drainUsage(f, newCursor(), 256)
    const second = drainUsage(f, first, 256)
    expect(second.offset).toBe(first.offset)
    expect(second.totals.outputTokens).toBe(50)
  })

  test('a drained cursor picks up only what was appended after it', () => {
    const f = fixture(line({ output_tokens: 5 }).repeat(10))
    const first = drainUsage(f, newCursor(), 256)
    appendFileSync(f, line({ output_tokens: 8 }))
    expect(drainUsage(f, first, 256).totals.outputTokens).toBe(58)
  })

  test('it records the file it drained, so the next read can tell it apart', () => {
    const f = fixture(line({ output_tokens: 1 }))
    expect(drainUsage(f, newCursor()).path).toBe(f)
  })
})

describe('usage: the suite never writes into a real Claude config dir', () => {
  // The assertions below only report damage already done; this refuses first.
  // The id arrives from the bridge as an unvalidated cast and becomes a path
  // segment here, so a traversal must not resolve — planted outside the root so
  // the check is what stops it, not the file simply being absent.
  test('a session id that traverses out of the projects root finds nothing', () => {
    const planted = plantTranscript(uniqueClaudeId('inside'), '')
    try {
      const escapeTarget = join(claudeConfigDir(), 'escape.jsonl')
      writeFileSync(escapeTarget, '')
      try {
        // join(projectsRoot(), <fixtureDir>, '../../escape.jsonl') lands on it.
        expect(existsSync(escapeTarget), 'the traversal target must really exist').toBe(true)
        expect(transcriptPathFor('../../escape')).toBeUndefined()
      } finally { rmSync(escapeTarget, { force: true }) }
    } finally { planted.cleanup() }
  })

  // readdirSync returns the link name and join+existsSync follow it, so an
  // entry planted inside the root can still point at a file outside it. This is
  // the one path-read the PR added that wasn't using its own containment helper.
  test('a symlinked project dir pointing outside the root is not followed', () => {
    const root = projectsRoot()
    const outside = mkdtempSync(join(tmpdir(), 'outside-root-'))
    const link = join(root, '-hydra-symlink-probe')
    try {
      const id = uniqueClaudeId('escapee')
      writeFileSync(join(outside, `${id}.jsonl`), JSON.stringify({ cwd: '/Users/kevin/private' }) + '\n')
      mkdirSync(root, { recursive: true })
      symlinkSync(outside, link)

      expect(existsSync(join(link, `${id}.jsonl`)), 'the link really does reach it').toBe(true)
      expect(transcriptPathFor(id), 'but the reader must not').toBeUndefined()
    } finally {
      rmSync(link, { force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test('an id outside the session-id shape is refused before it becomes a path', () => {
    expect(transcriptPathFor('..')).toBeUndefined()
    expect(transcriptPathFor('a/b')).toBeUndefined()
  })

  // A sibling, not a real directory: reproducing the original $HOME bug would
  // mean planting in $HOME, which is the thing being prevented. testStateDirRefusal
  // covers that direction without writing anything.
  test('planting outside the isolated root throws instead of writing', () => {
    const saved = process.env.CLAUDE_CONFIG_DIR
    try {
      process.env.CLAUDE_CONFIG_DIR = `${TEST_STATE_DIR}-EVIL`
      expect(() => plantTranscript(uniqueClaudeId('escape'), '')).toThrow(/outside the suite's own state dir/)
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = saved
    }
  })

  // Deleting the isolation in test-setup.ts left the suite green while planting
  // fixtures in the developer's live ~/.claude/projects. 19 leaked copies of one
  // fixture id made a scan return an arbitrary file and a test pass by accident.
  test('projectsRoot resolves under the throwaway state dir, not the real home', () => {
    const stateDir = process.env.HYDRA_STATE_DIR
    expect(stateDir, 'test-setup must have isolated the state dir').toBeTruthy()
    expect(projectsRoot().startsWith(stateDir!), `projectsRoot ${projectsRoot()} escaped ${stateDir}`).toBe(true)
    expect(projectsRoot().endsWith(`${sep}projects`), 'the real directory Claude writes is "projects"').toBe(true)
  })

  test('a planted fixture lands under that root', () => {
    const planted = plantTranscript(uniqueClaudeId('iso'), line({ output_tokens: 1 }))
    try {
      expect(planted.path.startsWith(projectsRoot())).toBe(true)
      expect(planted.path.startsWith(claudeConfigDir()), 'never outside the isolated config dir').toBe(true)
    } finally { planted.cleanup() }
  })
})

// A real transcript writes ONE content block per line, every line repeating the
// turn's whole usage envelope. So the tool_use blocks land on exactly the lines
// the envelope dedupe throws away. Reading tool names after the dedupe sees
// almost no tools at all.
// Exported so the turn-assembly half can be exercised without touching fs; the
// export claimed that and nothing imported it.
describe('usage: turnsIn assembles a turn from its lines', () => {
  const l = (o: unknown) => JSON.stringify(o) + '\n'

  test('the lines of one turn collapse to one usage envelope plus every tool', () => {
    const turns = turnsIn(
      l({ message: { id: 'a', usage: { output_tokens: 5 } } })
      + l({ message: { id: 'a', usage: { output_tokens: 5 }, content: [{ type: 'tool_use', name: 'Edit' }] } })
      + l({ message: { id: 'a', usage: { output_tokens: 5 }, content: [{ type: 'tool_use', name: 'Agent' }] } }),
    )
    expect(turns.length, 'one turn, not three').toBe(1)
    expect(turns[0]!.tools, 'tools from lines the envelope dedupe would drop').toEqual(['Edit', 'Agent'])
    expect(turns[0]!.usage?.output_tokens).toBe(5)
  })

  test('two ids are two turns, and a malformed line is skipped not thrown', () => {
    const turns = turnsIn(l({ message: { id: 'a', usage: { output_tokens: 1 } } })
      + 'not json\n' + l({ message: { id: 'b', usage: { output_tokens: 2 } } }))
    expect(turns.map(t => t.id)).toEqual(['a', 'b'])
  })
})

describe('usage: phase is read off the transcript', () => {
  // Distinct magnitudes per counter, so a dropped or swapped term is visible.
  const rich = (id: string, n: number, tools: string[] = []) =>
    JSON.stringify({ message: { id, role: 'assistant', usage: {
      input_tokens: n * 10, output_tokens: n, cache_creation_input_tokens: n * 100,
      cache_read_input_tokens: n * 1000 } } }) + '\n'
    + tools.map(name => JSON.stringify({ message: { id, role: 'assistant', usage: {
      input_tokens: n * 10, output_tokens: n, cache_creation_input_tokens: n * 100,
      cache_read_input_tokens: n * 1000 },
      content: [{ type: 'tool_use', name }] } }) + '\n').join('')

  const turn = (id: string, out: number, tools: string[] = []) =>
    JSON.stringify({ message: { id, role: 'assistant', usage: { output_tokens: out } } }) + '\n'
    + tools.map(name =>
      JSON.stringify({ message: { id, role: 'assistant', usage: { output_tokens: out },
        content: [{ type: 'tool_use', name, input: { prompt: 'must not escape' } }] } }) + '\n').join('')

  test('a fresh cursor starts in plan', () => {
    expect(newCursor().latch).toBe('plan')
    expect(readUsageDelta(fixture(turn('a', 5)), newCursor()).latch).toBe('plan')
  })

  // A real transcript interleaves the tool_result for one tool_use before the
  // next tool_use of the SAME message id. Without the structure-line skip the
  // turn splits and its tools are read apart: measured over 60 transcripts,
  // 31,174 spurious turns and 2.2% of output tokens moving phase.
  test('a tool_result between two tool_use lines does not split the turn', () => {
    const head = { id: 'a', role: 'assistant', usage: { output_tokens: 7 } }
    const body = JSON.stringify({ message: head }) + '\n'
      + JSON.stringify({ message: { ...head, content: [{ type: 'tool_use', name: 'reply' }] } }) + '\n'
      + JSON.stringify({ message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } }) + '\n'
      + JSON.stringify({ message: { ...head, content: [{ type: 'tool_use', name: 'Write' }] } }) + '\n'

    expect(turnsIn(body).map(t => t.tools), 'one turn, both tools').toEqual([['reply', 'Write']])
    const c = readUsageDelta(fixture(body), newCursor())
    expect(c.phaseTotals.execute.outputTokens, 'the Write is seen, so this is not a report turn').toBe(7)
    expect(c.phaseTotals.report.outputTokens).toBe(0)
  })

  // Voting on the tail alone let a late Edit outrank an Agent that latchVote
  // ranks above it, and the latch then mislabelled every tool-less turn after
  // it — unbounded, unlike the straddling turn's own envelope.
  test('a turn split across reads is classified on all its tools, not the last ones', () => {
    const head = { id: 'a', role: 'assistant', usage: { output_tokens: 10 } }
    const L = (o: object) => JSON.stringify({ message: o }) + '\n'
    const f = fixture(L(head) + L({ ...head, content: [{ type: 'tool_use', name: 'Agent' }] }))
    let c = readUsageDelta(f, newCursor())
    expect(c.latch).toBe('review')

    appendFileSync(f, L({ ...head, content: [{ type: 'tool_use', name: 'Edit' }] }))
    c = readUsageDelta(f, c)
    expect(c.latch, 'delegating outranks editing; the seam must not invert it').toBe('review')

    appendFileSync(f, L({ id: 'b', role: 'assistant', usage: { output_tokens: 500 } }))
    c = readUsageDelta(f, c)
    expect(c.phaseTotals.review.outputTokens, 'exactly what one read would give').toBe(510)
    expect(c.phaseTotals.execute.outputTokens).toBe(0)
  })

  // The cursor crosses an `unknown` boundary at the engine adapter. A read with
  // no new bytes returns the latch untouched by the turn loop, so this repair is
  // the only thing standing between a bogus value and phaseTotals[undefined],
  // which throws into the tick's catch and stops that session reporting for good.
  test('an idle read repairs a latch outside the set', () => {
    const f = fixture(turn('a', 5))
    const first = readUsageDelta(f, newCursor())
    const idle = readUsageDelta(f, { ...first, latch: 'bogus' as never })
    expect(idle.latch, 'no turns ran, so nothing else could have repaired it').toBe('plan')

    appendFileSync(f, turn('b', 9))
    expect(readUsageDelta(f, idle).phaseTotals.plan.outputTokens).toBe(14)
  })

  test.each([
    [['Agent'], 'review'],
    [['Edit'], 'execute'],
  ])('a turn using %p leaves the cursor latched in %s', (tools, phase) => {
    const c = readUsageDelta(fixture(turn('a', 5, tools as string[])), newCursor())
    expect(c.latch).toBe(phase as never)
    expect(c.phaseTotals[phase as 'review'].outputTokens, 'and its tokens land in that phase').toBe(5)
  })

  test('voted names only the phases a turn in this read actually chose', () => {
    const c = readUsageDelta(fixture(turn('a', 5, ['Edit']) + turn('b', 7, ['Bash'])), newCursor())
    expect(c.voted, 'Bash says nothing; the edit voted').toEqual(['execute'])
    expect(c.phaseTotals.execute.outputTokens, 'but both turns bill to execute').toBe(12)
  })

  test('a read with no votes at all reports none, though it still bills', () => {
    const c = readUsageDelta(fixture(turn('a', 5, ['Bash'])), newCursor())
    expect(c.voted).toEqual([])
    expect(c.phaseTotals.plan.outputTokens).toBe(5)
  })

  test('a reply counts as a vote for report', () => {
    const c = readUsageDelta(fixture(turn('a', 5, ['mcp__x__reply'])), newCursor())
    expect(c.voted).toEqual(['report'])
  })

  // One drain is one telemetry window, so a vote in an early pass still
  // describes it. With a per-pass reset the last pass silently wins.
  test('votes survive a multi-pass drain', () => {
    const body = turn('a', 5, ['Agent']) + turn('b', 7, ['Bash']).repeat(20)
    const c = drainUsage(fixture(body), newCursor(), 256)
    expect(c.voted, 'the Agent is in the first pass only').toEqual(['review'])
  })

  // Momentary: the tokens land in `report`, the latch does not follow. Latching
  // it billed runs of up to 135 consecutive Bash turns as reporting on four real
  // transcripts — 45-83% of spend against the ledger's 17%.
  test('a reply bills its own turn to report and leaves the latch alone', () => {
    const t = turn('a', 5, ['Edit']) + turn('b', 7, ['mcp__plugin_discord_discord__reply']) + turn('c', 11, ['Bash'])
    const c = readUsageDelta(fixture(t), newCursor())
    expect(c.phaseTotals.report.outputTokens, 'only the replying turn').toBe(7)
    expect(c.phaseTotals.execute.outputTokens, 'the edit AND the Bash turn after the reply').toBe(16)
    expect(c.latch).toBe('execute')
  })

  // The dedupe regression guard. Delete the pre-dedupe tool read and this fails:
  // the Agent block is on a line whose envelope is skipped.
  test('tools on a deduped line still move the phase', () => {
    const c = readUsageDelta(fixture(turn('a', 5, ['Agent'])), newCursor())
    expect(c.latch, 'the tool_use block is never the first line of its turn').toBe('review')
    expect(c.totals.outputTokens, 'while the envelope is still counted once').toBe(5)
  })

  // The case Kevin named: edit, then hand off to reviewers. If the phase moved
  // after the turn was attributed, these 7 tokens would be billed to execute.
  test('a turn that edits and then delegates bills the handoff to review', () => {
    const body = turn('a', 3, ['Edit']) + turn('b', 7, ['Agent'])
    const c = readUsageDelta(fixture(body), newCursor())
    expect(c.phaseTotals.execute.outputTokens, 'the edit turn is execute').toBe(3)
    expect(c.phaseTotals.review.outputTokens, 'the delegating turn is already review').toBe(7)
    expect(c.phaseTotals.plan.outputTokens).toBe(0)
  })

  test('the phase survives a drain, so a quiet window keeps spending in it', () => {
    const f = fixture(turn('a', 3, ['Agent']))
    const first = readUsageDelta(f, newCursor())
    expect(first.latch).toBe('review')
    appendFileSync(f, turn('b', 11) + turn('c', 13))
    const second = readUsageDelta(f, first)
    expect(second.latch, 'nothing said otherwise').toBe('review')
    expect(second.phaseTotals.review.outputTokens, 'the quiet turns are review spend').toBe(27)
  })

  test('a rotated transcript restarts in plan rather than inheriting a phase', () => {
    const f = fixture(turn('a', 3, ['Agent']))
    const first = readUsageDelta(f, newCursor())
    writeFileSync(f, turn('z', 4))
    const second = readUsageDelta(f, first)
    expect(second.restartedFromZero).toBe(true)
    expect(second.latch, 'a new transcript inherits nothing').toBe('plan')
    expect(second.phaseTotals.review.outputTokens, 'and neither do its buckets').toBe(0)
  })

  // All four counters: the split and sumTotals were only ever exercised on
  // outputTokens, so dropping a cacheCreate or cacheRead term survived the suite
  // — and a cache-read-only window being filtered out loses those tokens for good.
  test('the phase buckets always add up to the session total, on every counter', () => {
    const body = rich('a', 1, ['Edit']) + rich('b', 2, ['Agent']) + rich('c', 3)
      + rich('d', 4, ['mcp__plugin_slack_slack__slack_send_message'])
    const c = readUsageDelta(fixture(body), newCursor())
    expect(sumTotals(USAGE_PHASES.map(p => c.phaseTotals[p])),
      'no turn may be dropped or double-counted by the split').toEqual(c.totals)
    expect(c.totals, 'and every counter is actually carried').toEqual({
      inputTokens: 100, outputTokens: 10, cacheCreateTokens: 1000, cacheReadTokens: 10000,
    })
  })

  test('a window whose only spend is cache-read still registers as spend', () => {
    const only = JSON.stringify({ message: { id: 'z', role: 'assistant',
      usage: { cache_read_input_tokens: 4242 } } }) + '\n'
    const c = readUsageDelta(fixture(only), newCursor())
    expect(c.totals.cacheReadTokens).toBe(4242)
    expect(totalsChanged(zeroTotals(), c.totals), 'or the window is filtered out and lost').toBe(true)
  })

  test('a turn straddling two reads is not re-counted, but its late tools still land', () => {
    const f = fixture(JSON.stringify({ message: { id: 'a', role: 'assistant', usage: { output_tokens: 9 } } }) + '\n')
    const first = readUsageDelta(f, newCursor())
    expect(first.latch).toBe('plan')
    appendFileSync(f, JSON.stringify({ message: { id: 'a', role: 'assistant', usage: { output_tokens: 9 },
      content: [{ type: 'tool_use', name: 'Agent' }] } }) + '\n')
    const second = readUsageDelta(f, first)
    expect(second.totals.outputTokens, 'the envelope counts once across the seam').toBe(9)
    expect(second.latch, 'but the tool on the far side still moves the phase').toBe('review')
  })
})

// An id-less line can be neither deduped nor grouped, so it stands alone.
// `line()` above produces exactly this shape, so every pre-existing fixture in
// this file rides it — but no phase assertion did.
describe('usage: turns with no message id still bucket correctly', () => {
  const bare = (out: number, tools: string[] = []) =>
    JSON.stringify({ message: { role: 'assistant', usage: { output_tokens: out },
      content: tools.map(name => ({ type: 'tool_use', name })) } }) + '\n'

  // The whole block below uses id-less lines only, so an id-less line FOLLOWING
  // an id-bearing one never ran. Inheriting the open turn's id there would feed
  // it to the dedupe and discard its tokens.
  test('an id-less line after an id-bearing turn is not absorbed into it', () => {
    const withId = JSON.stringify({ message: { id: 'a', role: 'assistant', usage: { output_tokens: 4 } } }) + '\n'
    const c = readUsageDelta(fixture(withId + bare(11)), newCursor())
    expect(turnsIn(withId + bare(11)).length, 'two turns, not one').toBe(2)
    expect(c.totals.outputTokens, 'and both sets of tokens count').toBe(15)
  })

  test('an id-less turn is attributed to the phase its own tools chose', () => {
    const c = readUsageDelta(fixture(bare(10) + bare(20, ['Agent']) + bare(30)), newCursor())
    expect(c.phaseTotals.plan.outputTokens, 'before any vote').toBe(10)
    expect(c.phaseTotals.review.outputTokens, 'the voting turn and the one that latched after it').toBe(50)
    expect(c.totals.outputTokens).toBe(60)
  })

  test('the bucket sum invariant holds on the id-less path too', () => {
    const c = readUsageDelta(fixture(bare(3, ['Edit']) + bare(7) + bare(11, ['Agent'])), newCursor())
    const summed = USAGE_PHASES.reduce((n, p) => n + c.phaseTotals[p].outputTokens, 0)
    expect(summed).toBe(c.totals.outputTokens)
  })

  // Two id-less turns in a row must not merge into one.
  test('consecutive id-less turns both count', () => {
    expect(readUsageDelta(fixture(bare(5) + bare(5)), newCursor()).totals.outputTokens).toBe(10)
  })
})

describe('usage: subagent transcripts', () => {
  const planted: Array<() => void> = []
  const logged: string[] = []
  const realWrite = process.stderr.write
  beforeEach(() => {
    logged.length = 0
    process.stderr.write = ((chunk: string | Uint8Array) => { logged.push(String(chunk)); return true }) as typeof process.stderr.write
  })
  afterEach(() => {
    process.stderr.write = realWrite
    while (planted.length) planted.pop()!()
  })

  function plantSession(prefix: string, main: string) {
    const id = uniqueClaudeId(prefix)
    const session = plantTranscript(id, main)
    planted.push(session.cleanup)
    return { ...session, id }
  }

  test('subagent spend folds into the session total and books to review, even when the subagent edits', () => {
    const s = plantSession('fold', turnLines('m1', 10, ['Edit']))
    plantSubagent(s.path, 'agent-a.jsonl', turnLines('s1', 7))
    plantSubagent(s.path, 'agent-b.jsonl', turnLines('s2', 5, ['Edit']))
    const r = drainSession(s.path, newSessionCursor())
    expect(r.totals.outputTokens).toBe(22)
    expect(r.phaseTotals.execute.outputTokens, 'the parent keeps its own split').toBe(10)
    expect(r.phaseTotals.review.outputTokens, 'a subagent inherits its spawn phase, not its own tools').toBe(12)
    expect(sumTotals(USAGE_PHASES.map(p => r.phaseTotals[p])).outputTokens, 'the split still sums to the total').toBe(22)
    expect(r.latch, 'the parent alone steers the latch').toBe('execute')
  })

  test('a Workflow run one level down is counted too, and its other files are not', () => {
    const s = plantSession('wf', turnLines('m1', 1))
    plantSubagent(s.path, 'agent-w.jsonl', turnLines('w1', 30), 'wf_044b3fe1-ad4')
    plantSubagent(s.path, 'journal.jsonl', turnLines('x1', 1000), 'wf_044b3fe1-ad4')
    plantSubagent(s.path, 'agent-z.jsonl', turnLines('x2', 1000), 'not-a-run')
    expect(drainSession(s.path, newSessionCursor()).totals.outputTokens).toBe(31)
  })

  test('spend is counted once across repeated drains, and an append adds only its new bytes', () => {
    const s = plantSession('once', turnLines('m1', 10))
    const agent = plantSubagent(s.path, 'agent-a.jsonl', turnLines('s1', 7))
    const first = drainSession(s.path, newSessionCursor())
    const again = drainSession(s.path, first.cursor)
    expect([again.totals.outputTokens, again.restarted]).toEqual([17, false])
    appendFileSync(agent, turnLines('s2', 4))
    const grown = drainSession(s.path, again.cursor)
    expect([grown.totals.outputTokens, grown.restarted]).toEqual([21, false])
  })

  test('a read where only subagents spent votes review, so the row reads as chosen, not carried', () => {
    const s = plantSession('vote', turnLines('m1', 10, ['Edit']))
    const agent = plantSubagent(s.path, 'agent-a.jsonl', turnLines('s1', 7))
    const first = drainSession(s.path, newSessionCursor())
    const idle = drainSession(s.path, first.cursor)
    expect(idle.voted, 'a subagent that spent nothing new votes nothing').toEqual([])
    appendFileSync(agent, turnLines('s2', 3))
    expect(drainSession(s.path, idle.cursor).voted).toEqual(['review'])
  })

  test('a subagent that appears mid-session is added without reading as a restart', () => {
    const s = plantSession('late', turnLines('m1', 10))
    const first = drainSession(s.path, newSessionCursor())
    expect(first.restarted, "the parent's own first read is a cold start").toBe(true)
    const quiet = drainSession(s.path, first.cursor)
    plantSubagent(s.path, 'agent-new.jsonl', turnLines('s1', 9))
    const joined = drainSession(s.path, quiet.cursor)
    expect([joined.totals.outputTokens, joined.restarted]).toEqual([19, false])
  })

  test('a subagent file rewritten shorter re-banks instead of resending the turns it repeats', () => {
    const s = plantSession('shrink', turnLines('m1', 10))
    const agent = plantSubagent(s.path, 'agent-a.jsonl', turnLines('s1', 2000) + turnLines('s2', 5))
    const first = drainSession(s.path, newSessionCursor())
    writeFileSync(agent, turnLines('s1', 2000))
    const after = drainSession(s.path, first.cursor)
    expect(after.restarted, 's1 was already delivered').toBe(true)
    expect(after.totals.outputTokens, 'the cumulative never falls').toBeGreaterThanOrEqual(first.totals.outputTokens)
  })

  test('a subagent file truncated to empty keeps what it spent and does not restart the session', () => {
    const s = plantSession('emptied', turnLines('m1', 10))
    const agent = plantSubagent(s.path, 'agent-a.jsonl', turnLines('s1', 2000))
    const first = drainSession(s.path, newSessionCursor())
    writeFileSync(agent, '')
    appendFileSync(s.path, turnLines('m2', 50))
    const after = drainSession(s.path, first.cursor)
    expect(after.restarted, "nothing was re-read, and a restart would drop the parent's new 50").toBe(false)
    expect(after.totals.outputTokens).toBe(10 + 50 + 2000)
    expect(after.phaseTotals.review.outputTokens).toBe(2000)
  })

  test('a session with no subagents directory reads exactly as its parent transcript', () => {
    const s = plantSession('solo', turnLines('m1', 10, ['Edit']) + turnLines('m2', 3))
    const r = drainSession(s.path, newSessionCursor())
    const alone = drainUsage(s.path, newCursor())
    expect(r.totals).toEqual(alone.totals)
    expect(r.phaseTotals).toEqual(alone.phaseTotals)
    expect(logged, 'having no subagents is normal, not a failure').toEqual([])
  })

  test('a session path that is a file has no subagents, which is not a failure', () => {
    const s = plantSession('asfile', turnLines('m1', 10))
    writeFileSync(join(s.dir, s.id), 'not a directory')
    const r = drainSession(s.path, newSessionCursor())
    expect([r.totals.outputTokens, r.cursor.missingFromBaseline, logged]).toEqual([10, [], []])
  })

  test('only agent-*.jsonl is read — the meta.json sidecar and stray files are not', () => {
    const s = plantSession('sidecar', turnLines('m1', 1))
    const agent = plantSubagent(s.path, 'agent-a.jsonl', turnLines('s1', 7))
    plantSubagent(s.path, 'agent-a.meta.json', turnLines('x1', 1000))
    plantSubagent(s.path, 'notes.jsonl', turnLines('x2', 1000))
    expect(subagentPathsFor(s.path)).toEqual([agent])
    expect(drainSession(s.path, newSessionCursor()).totals.outputTokens).toBe(8)
  })

  test('a subagent file that leaves the projects root through a symlink is not read', () => {
    const outside = mkdtempSync(join(tmpdir(), 'usage-outside-'))
    planted.push(() => rmSync(outside, { recursive: true, force: true }))
    const target = join(outside, 'agent-evil.jsonl')
    writeFileSync(target, turnLines('x1', 1000))
    const s = plantSession('escape', turnLines('m1', 1))
    const agent = plantSubagent(s.path, 'agent-a.jsonl', turnLines('s1', 7))
    symlinkSync(target, join(dirname(agent), 'agent-evil.jsonl'))
    expect(subagentPathsFor(s.path)).toEqual([agent])
    expect(drainSession(s.path, newSessionCursor()).totals.outputTokens).toBe(8)
  })

  test('an unreadable subagent is logged by name once per read and does not silence the parent or its siblings', () => {
    const s = plantSession('bad', turnLines('m1', 10))
    plantSubagent(s.path, 'agent-a.jsonl', turnLines('s1', 7))
    const bad = plantUnreadableSubagent(s.path)
    const first = drainSession(s.path, newSessionCursor())
    expect(first.totals.outputTokens).toBe(17)
    appendFileSync(s.path, turnLines('m2', 5))
    expect(drainSession(s.path, first.cursor).totals.outputTokens).toBe(22)
    expect(logged).toHaveLength(2)
    expect(logged.filter(l => !l.includes(bad))).toEqual([])
  })

  test('a directory with an agent name is skipped without a log', () => {
    const s = plantSession('dirname', turnLines('m1', 10))
    mkdirSync(join(dirname(plantSubagent(s.path, 'agent-a.jsonl', turnLines('s1', 7))), 'agent-x.jsonl'))
    expect(drainSession(s.path, newSessionCursor()).totals.outputTokens).toBe(17)
    expect(logged).toEqual([])
  })

  test('a file named like a Workflow run does not hide the other subagents', () => {
    const s = plantSession('wfbogus', turnLines('m1', 1))
    plantSubagent(s.path, 'agent-a.jsonl', turnLines('s1', 7))
    plantSubagent(s.path, 'agent-w.jsonl', turnLines('w1', 30), 'wf_real')
    writeFileSync(join(subagentsDirOf(s.path), 'workflows', 'wf_bogus'), 'not a run')
    expect(drainSession(s.path, newSessionCursor()).totals.outputTokens).toBe(38)
  })

  test.each([
    ['a subagent',
      (t: string) => plantUnreadableSubagent(t),
      (broken: string) => healSubagent(broken, turnLines('s1', 1000))],
    ['the listing',
      (t: string) => plantBrokenListing(t),
      (broken: string, t: string) => { rmSync(broken); plantSubagent(t, 'agent-y.jsonl', turnLines('s1', 1000)) }],
  ])('a cold read that could not read %s re-banks once it can, and only once', (_label, breakIt, fixIt) => {
    const s = plantSession('rebank', turnLines('m1', 10))
    const broken = breakIt(s.path)
    const cold = drainSession(s.path, newSessionCursor())
    expect([cold.restarted, cold.totals.outputTokens]).toEqual([true, 10])
    const still = drainSession(s.path, cold.cursor)
    expect(still.restarted, 'still failing: nothing to re-bank, the parent keeps reporting').toBe(false)
    fixIt(broken, s.path)
    const healed = drainSession(s.path, still.cursor)
    expect([healed.restarted, healed.totals.outputTokens], 'baseline re-banked with the full history').toEqual([true, 1010])
    expect(drainSession(s.path, healed.cursor).restarted).toBe(false)
  })

  test.each([
    ['the session directory is unsearchable', (t: string) => join(dirname(t), basename(t, '.jsonl')), 0o000],
    ['subagents/ is listable but not searchable', (t: string) => subagentsDirOf(t), 0o644],
  ])('a baseline read where %s is a failed listing, not an empty one', (_label, dirOf, mode) => {
    if (process.getuid?.() === 0) return
    const s = plantSession('eacces', turnLines('m1', 10))
    plantSubagent(s.path, 'agent-w.jsonl', turnLines('w1', 1000), 'wf_run')
    const dir = dirOf(s.path)
    chmodSync(dir, mode)
    let cold: ReturnType<typeof drainSession>
    try { cold = drainSession(s.path, newSessionCursor()) } finally { chmodSync(dir, 0o755) }
    expect([cold.restarted, cold.cursor.missingFromBaseline]).toEqual([true, null])
    const healed = drainSession(s.path, cold.cursor)
    expect([healed.restarted, healed.totals.outputTokens], 're-banked, not delivered as a delta').toEqual([true, 1010])
  })

  test('each subagent missing from the baseline re-banks as it heals, even while another still fails', () => {
    const s = plantSession('partial', turnLines('m1', 10))
    const a = plantUnreadableSubagent(s.path, 'agent-a.jsonl')
    const b = plantUnreadableSubagent(s.path, 'agent-b.jsonl')
    const cold = drainSession(s.path, newSessionCursor())
    healSubagent(b, turnLines('b1', 1000))
    const bHealed = drainSession(s.path, cold.cursor)
    expect(bHealed.restarted, 'b is missing from the baseline, so it re-banks rather than arriving as a delta').toBe(true)
    const quiet = drainSession(s.path, bHealed.cursor)
    expect(quiet.restarted, 'a is still failing').toBe(false)
    healSubagent(a, turnLines('a1', 100))
    const aHealed = drainSession(s.path, quiet.cursor)
    expect([aHealed.restarted, aHealed.totals.outputTokens]).toEqual([true, 1110])
    expect(drainSession(s.path, aHealed.cursor).restarted).toBe(false)
  })

  test('a genuinely new subagent while another stays broken is real spend, not a re-bank', () => {
    const s = plantSession('newbie', turnLines('m1', 10))
    plantUnreadableSubagent(s.path, 'agent-a.jsonl')
    const cold = drainSession(s.path, newSessionCursor())
    plantSubagent(s.path, 'agent-new.jsonl', turnLines('n1', 40))
    const next = drainSession(s.path, cold.cursor)
    expect([next.restarted, next.totals.outputTokens]).toEqual([false, 50])
  })

  test('a subagent that was banked and then fails is not missing from the baseline', () => {
    const s = plantSession('banked', turnLines('m1', 10))
    const a = plantSubagent(s.path, 'agent-a.jsonl', turnLines('a1', 7))
    const b = plantUnreadableSubagent(s.path, 'agent-b.jsonl')
    const cold = drainSession(s.path, newSessionCursor())
    healSubagent(b, turnLines('b1', 100))
    rmSync(a)
    plantUnreadableSubagent(s.path, 'agent-a.jsonl')
    const bHealed = drainSession(s.path, cold.cursor)
    expect([bHealed.restarted, bHealed.totals.outputTokens], "b's heal re-banks, with a's old spend still in it").toEqual([true, 117])
    expect(drainSession(s.path, bHealed.cursor).restarted, "a failing again is not a heal").toBe(false)
  })

  test('a new subagent that fails its first read on a heal tick is ordinary spend once it reads', () => {
    const s = plantSession('coincide', turnLines('m1', 10))
    const a = plantUnreadableSubagent(s.path, 'agent-a.jsonl')
    const cold = drainSession(s.path, newSessionCursor())
    healSubagent(a, turnLines('a1', 100))
    const c = plantUnreadableSubagent(s.path, 'agent-c.jsonl')
    const aHealed = drainSession(s.path, cold.cursor)
    expect(aHealed.restarted, "a's heal re-banks").toBe(true)
    healSubagent(c, turnLines('c1', 500))
    const cRead = drainSession(s.path, aHealed.cursor)
    expect([cRead.restarted, cRead.totals.outputTokens], 'c was in no baseline, so its spend is a delta').toEqual([false, 610])
  })

  test('a listing that recovers with nothing readable leaves later new subagents as ordinary spend', () => {
    const s = plantSession('relist', turnLines('m1', 10))
    const listing = plantBrokenListing(s.path)
    const cold = drainSession(s.path, newSessionCursor())
    rmSync(listing)
    plantUnreadableSubagent(s.path)
    const relisted = drainSession(s.path, cold.cursor)
    expect(relisted.restarted, 'nothing read, nothing to re-bank').toBe(false)
    plantSubagent(s.path, 'agent-new.jsonl', turnLines('n1', 40))
    const next = drainSession(s.path, relisted.cursor)
    expect([next.restarted, next.totals.outputTokens]).toEqual([false, 50])
  })

  test('a steady-state read failure does not re-bank, since nothing was banked without it', () => {
    const s = plantSession('steady', turnLines('m1', 10))
    const first = drainSession(s.path, newSessionCursor())
    const broken = plantUnreadableSubagent(s.path)
    const failing = drainSession(s.path, first.cursor)
    healSubagent(broken, turnLines('s1', 40))
    const healed = drainSession(s.path, failing.cursor)
    expect([failing.restarted, healed.restarted, healed.totals.outputTokens]).toEqual([false, false, 50])
  })

  test('a subagent file that disappears keeps its spend, so the cumulative never falls', () => {
    const s = plantSession('gone', turnLines('m1', 10))
    const agent = plantSubagent(s.path, 'agent-a.jsonl', turnLines('s1', 7))
    const first = drainSession(s.path, newSessionCursor())
    rmSync(agent)
    const after = drainSession(s.path, first.cursor)
    expect([after.totals.outputTokens, after.restarted]).toEqual([17, false])
  })

  test('a parent that moves rebuilds its subagents, so a stale cursor cannot double-count them', () => {
    const s = plantSession('moved', turnLines('m1', 10))
    const agent = plantSubagent(s.path, 'agent-a.jsonl', turnLines('s1', 700))
    const before = drainSession(s.path, newSessionCursor())
    writeFileSync(agent, turnLines('s2', 3))
    const first = drainSession(s.path, before.cursor)
    expect(first.totals.outputTokens, 'the shrink retired 700').toBe(713)
    const dest = mkdtempSync(join(projectsRoot(), '-hydra-fixture-'))
    planted.push(() => rmSync(dest, { recursive: true, force: true }))
    const moved = join(dest, `${s.id}.jsonl`)
    renameSync(s.path, moved)
    renameSync(join(s.dir, s.id), join(dest, s.id))
    const after = drainSession(moved, first.cursor)
    expect(after.restarted).toBe(true)
    expect(after.totals.outputTokens, 'rebuilt from what is on disk').toBe(13)
  })
})
