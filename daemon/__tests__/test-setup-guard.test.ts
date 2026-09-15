import { describe, test, expect } from 'bun:test'
import { isForbiddenStateDir, FORBIDDEN_STATE_DIR_PREFIX } from '../../test-setup.js'
import { join } from 'path'
import { homedir } from 'os'

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
