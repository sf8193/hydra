import { test, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { currentResultWord, readJobState, stateFile, writeAtomic } from '../jobs.js'

// Job state and result files written before `not-now` became `deferred` still read.

test('a job state file with the old notNow field reads as deferred, and the old field is gone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jobs-old-'))
  try {
    writeAtomic(stateFile(dir, 'sweep'), JSON.stringify({ notNow: { since: '2026-11-01T00:00:00Z', reason: 'offline', dispatch: 3 } }))
    const r = readJobState(dir, 'sweep', '0 6 * * *')
    expect(r.kind === 'ok' && r.state).toEqual({ deferred: { since: '2026-11-01T00:00:00Z', reason: 'offline', dispatch: 3 } })
    // Both present: the new field wins.
    writeAtomic(stateFile(dir, 'sweep'), JSON.stringify({ notNow: { since: 'old', reason: 'x' }, deferred: { since: 'new', reason: 'y' } }))
    const both = readJobState(dir, 'sweep', '0 6 * * *')
    expect(both.kind === 'ok' && both.state).toEqual({ deferred: { since: 'new', reason: 'y' } })
  } finally { rmSync(dir, { recursive: true }) }
})

test('a result file that says not-now reads as deferred; every other word is left alone', () => {
  expect(currentResultWord({ result: 'not-now', note: 'offline' })).toEqual({ result: 'deferred', note: 'offline' })
  for (const word of ['done', 'nothing', 'failed', 'deferred']) expect(currentResultWord({ result: word })).toEqual({ result: word })
})
