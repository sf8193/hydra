import { describe, test, expect } from 'bun:test'
import { isForbiddenStateDir, FORBIDDEN_STATE_DIR_PREFIX, sweepStaleTestDirs, testStateDirRefusal, TEST_DIR_PREFIX } from '../../test-setup.js'
import { existsSync, lutimesSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir, tmpdir } from 'os'

// Pure-predicate unit test — no subprocess, no bun-test-under-bun-test. Round 2
// of the review flagged that the runtime guard itself (isForbiddenStateDir)
// shipped with zero coverage, same untested-safety-fix pattern as the bug it
// closes. test-setup.ts is already loaded once via bunfig's [test] preload, so
// this import returns the cached module rather than re-running its top-level
// side effects (mkdtempSync, the process.env mutation) a second time.
describe('isForbiddenStateDir', () => {
  test('the real production discord state dir is forbidden', () => {
    expect(isForbiddenStateDir(join(homedir(), '.claude', 'channels', 'discord'))).toBe(true)
  })

  test('any platform under ~/.claude/channels is forbidden, not just discord', () => {
    expect(isForbiddenStateDir(join(homedir(), '.claude', 'channels', 'slack'))).toBe(true)
    expect(isForbiddenStateDir(FORBIDDEN_STATE_DIR_PREFIX)).toBe(true)
  })

  test('a sibling directory that merely starts with the same string is NOT forbidden', () => {
    // Regression case for the raw-startsWith bug: ~/.claude/channels-backup
    // is a different directory, not a subdirectory of ~/.claude/channels.
    expect(isForbiddenStateDir(join(homedir(), '.claude', 'channels-backup', 'foo'))).toBe(false)
  })

  test('an ordinary temp/test directory is not forbidden', () => {
    expect(isForbiddenStateDir('/tmp/hydra-test-abc123')).toBe(false)
    expect(isForbiddenStateDir('/tmp/some-explicit-test-dir')).toBe(false)
  })

  test('a relative path is resolved against cwd before checking', () => {
    // Not forbidden from the repo root, regardless of cwd — sanity check that
    // resolve() is actually being applied, not comparing raw strings.
    expect(isForbiddenStateDir('./some-relative-dir')).toBe(false)
  })
})

// The preload is the only thing in the suite that calls rmSync recursively over
// a shared directory. Both of its guards were unpinned.
describe('testStateDirRefusal', () => {
  test('a dir under the temp root is accepted, in either spelling', () => {
    expect(testStateDirRefusal(join(tmpdir(), 'inspect-me'))).toBeUndefined()
    expect(testStateDirRefusal(tmpdir())).toBeUndefined()
    // macOS spells tmpdir() through a symlink; a developer who ran `pwd -P`
    // was being refused a directory they were in fact inside.
    const real = realpathSync(tmpdir())
    expect(testStateDirRefusal(join(real, 'inspect-me')), `${real} is the same root`).toBeUndefined()
  })

  test.each([
    ['the home directory', () => homedir()],
    ['a dir in the home directory', () => join(homedir(), '.hydra-isolation-probe')],
    ['a sibling of the temp root', () => `${tmpdir()}-EVIL`],
  ])('%s is refused', (_case, candidate) => {
    const refusal = testStateDirRefusal(candidate())
    expect(refusal, 'must refuse').toBeTruthy()
    expect(refusal).toContain('outside')
  })
})

describe('sweepStaleTestDirs', () => {
  const DAY = 24 * 60 * 60 * 1000
  const NOW = 1789752921748

  const plant = (root: string, name: string, ageMs: number): string => {
    const dir = join(root, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'state.json'), '{}')
    const at = new Date(NOW - ageMs)
    utimesSync(dir, at, at)
    return dir
  }

  test('removes only prefixed directories older than the bound', () => {
    const root = mkdtempSync(join(tmpdir(), 'sweep-root-'))
    try {
      const stale = plant(root, `${TEST_DIR_PREFIX}old`, DAY + 1000)
      const fresh = plant(root, `${TEST_DIR_PREFIX}new`, 1000)
      const foreign = plant(root, 'someone-elses-old-dir', DAY * 30)

      const removed = sweepStaleTestDirs(root, NOW, DAY)

      expect(removed).toEqual([stale])
      expect(existsSync(stale), 'a day-old test dir goes').toBe(false)
      expect(existsSync(fresh), 'a concurrent run stays').toBe(true)
      expect(existsSync(foreign), 'and nothing unprefixed is ever touched').toBe(true)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('a directory exactly at the bound is kept, not removed', () => {
    const root = mkdtempSync(join(tmpdir(), 'sweep-root-'))
    try {
      const edge = plant(root, `${TEST_DIR_PREFIX}edge`, DAY)
      expect(sweepStaleTestDirs(root, NOW, DAY)).toEqual([])
      expect(existsSync(edge)).toBe(true)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  // statSync follows the link, so a symlink to something fresh read as fresh —
  // and the entry being aged out is the link, not its target.
  test('a stale symlink is aged by its own mtime, not its target', () => {
    const root = mkdtempSync(join(tmpdir(), 'sweep-root-'))
    try {
      const fresh = plant(root, 'target-kept-fresh', 1000)
      const link = join(root, `${TEST_DIR_PREFIX}link`)
      symlinkSync(fresh, link)
      const old = new Date(NOW - DAY - 1000)
      lutimesSync(link, old, old)

      expect(sweepStaleTestDirs(root, NOW, DAY)).toEqual([link])
      expect(existsSync(link), 'the stale link goes').toBe(false)
      expect(existsSync(fresh), 'its fresh target stays').toBe(true)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  // The prefix matches files too, and rmSync would take them — the sweep is
  // aging out throwaway state dirs, not anything else that shares the name.
  test('a stale file with the prefix is left alone', () => {
    const root = mkdtempSync(join(tmpdir(), 'sweep-root-'))
    try {
      const file = join(root, `${TEST_DIR_PREFIX}stray.log`)
      writeFileSync(file, 'x')
      const old = new Date(NOW - DAY - 1000)
      utimesSync(file, old, old)
      const dir = plant(root, `${TEST_DIR_PREFIX}dir`, DAY + 1000)

      expect(sweepStaleTestDirs(root, NOW, DAY)).toEqual([dir])
      expect(existsSync(file), 'only directories are swept').toBe(true)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('an unreadable root is a no-op, not a throw', () => {
    expect(() => sweepStaleTestDirs('/nope/not/a/dir', NOW, DAY)).not.toThrow()
    expect(sweepStaleTestDirs('/nope/not/a/dir', NOW, DAY)).toEqual([])
  })
})
