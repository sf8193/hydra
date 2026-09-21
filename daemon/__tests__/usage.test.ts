import { describe, test, expect, afterEach } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync, appendFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { homedir, tmpdir } from 'os'
import { join, sep } from 'path'
import { drainUsage, latestCwd, newCursor, projectDirName, projectDirNames, projectsRoot, readUsageDelta, totalsChanged, transcriptPathFor, zeroTotals } from '../usage.js'
import { plantTranscript, uniqueClaudeId } from './projects-fixture.js'
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
      message: { role: 'assistant', id: `msg_${SECRETS[0]}`, content: SECRETS.join(' '), usage: { output_tokens: 3 } },
      summary: SECRETS.join(' | '),
    }) + '\n',
  )

  test('the four counters are all a caller can read out', () => {
    const cursor = readUsageDelta(planted(), newCursor())
    expect(Object.keys(cursor.totals).sort()).toEqual(
      ['cacheCreateTokens', 'cacheReadTokens', 'inputTokens', 'outputTokens'],
    )
  })

  // The cursor is memory-only and carries two strings lifted from the file. If
  // either is ever widened onto SessionUsage, this is what has to be revisited.
  test('the cursor holds transcript text, and exactly two fields of it', () => {
    const cursor = readUsageDelta(planted(), newCursor())
    expect(cursor.lastMessageId, 'the id comes straight off the line').toContain(SECRETS[0])
    expect(Object.keys(cursor).filter(k => typeof (cursor as Record<string, unknown>)[k] === 'string').sort())
      .toEqual(['lastMessageId', 'path'])
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
    const c = readUsageDelta(f, { offset: 9_999, totals: { inputTokens: 5, outputTokens: 5, cacheCreateTokens: 5, cacheReadTokens: 5 }, lastMessageId: 'msg_a' })
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

  test('the same file with its own cursor keeps accumulating', () => {
    const f = fixture(line({ output_tokens: 5 }))
    const first = readUsageDelta(f, newCursor())
    appendFileSync(f, line({ output_tokens: 6 }))
    expect(readUsageDelta(f, first).totals.outputTokens).toBe(11)
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
