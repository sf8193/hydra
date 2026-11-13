// The probes a real load uses (systemEnv), on a real folder: symlinks out (including a dangling one), nested repositories,
// the entry cap failing closed, git work trees, and the state and config dirs the daemon passes in.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { scanWorkdirOnDisk, systemEnv } from '../load.js'

let root: string
let dir: string
let outside: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'sysenv-')))
  dir = join(root, 'workdir'); outside = join(root, 'outside')
  mkdirSync(dir); mkdirSync(outside)
  writeFileSync(join(outside, 'secret.txt'), 's')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('scanWorkdirOnDisk', () => {
  test('a clean folder: nothing escapes, nothing nested, not truncated', () => {
    mkdirSync(join(dir, 'a')); writeFileSync(join(dir, 'a', 'f.md'), 'x'); symlinkSync(join(dir, 'a'), join(dir, 'inside-link'))
    expect(scanWorkdirOnDisk(dir)).toEqual({ escapingSymlinks: [], nestedGit: [], truncated: false })
  })
  test('a symlink that resolves outside is found, deep down too', () => {
    mkdirSync(join(dir, 'a', 'b'), { recursive: true }); symlinkSync(outside, join(dir, 'a', 'b', 'out'))
    expect(scanWorkdirOnDisk(dir).escapingSymlinks).toEqual([join(realpathSync(dir), 'a', 'b', 'out')])
  })
  test('a dangling symlink counts as leaving: where it points cannot be checked', () => {
    symlinkSync(join(root, 'does-not-exist'), join(dir, 'dangling'))
    expect(scanWorkdirOnDisk(dir).escapingSymlinks).toEqual([join(realpathSync(dir), 'dangling')])
  })
  test('a nested git repository is found; the folder\'s own .git is the git-work-tree check\'s, not this one\'s', () => {
    mkdirSync(join(dir, '.git')); mkdirSync(join(dir, 'vendor', 'lib', '.git'), { recursive: true })
    expect(scanWorkdirOnDisk(dir).nestedGit).toEqual([join(realpathSync(dir), 'vendor', 'lib', '.git')])
  })
  test('past the entry cap it says it stopped looking (the loader refuses), and does not report a clean scan', () => {
    for (let i = 0; i < 12; i++) writeFileSync(join(dir, `f${i}`), 'x')
    expect(scanWorkdirOnDisk(dir, 5).truncated).toBe(true)
    expect(scanWorkdirOnDisk(dir, 50).truncated).toBe(false)
  })
  test('a symlink after the cap is not missed silently: the scan is truncated, which refuses the folder', () => {
    for (let i = 0; i < 12; i++) writeFileSync(join(dir, `f${i}`), 'x')
    symlinkSync(outside, join(dir, 'zz-out'))
    const r = scanWorkdirOnDisk(dir, 5)
    expect(r.truncated).toBe(true)
  })
})

describe('systemEnv: the state dir\'s .env', () => {
  test('envFileHas finds a variable the file sets, with export, quotes and comments handled, and nothing it does not', () => {
    writeFileSync(join(root, '.env'), '# comment\nexport DD_API_KEY="abc"\nOTHER=1 # note\nEMPTY=\n')
    const env = systemEnv([], root)
    expect(env.envFileHas('DD_API_KEY')).toBe(true)
    expect(env.envFileHas('OTHER')).toBe(true)
    expect(env.envFileHas('EMPTY')).toBe(false)   // blank counts as absent, as the daemon's own env reading does
    expect(env.envFileHas('MISSING')).toBe(false)
  })
  test('no .env at all: nothing is set', () => {
    expect(systemEnv([], join(root, 'no-such-state')).envFileHas('DD_API_KEY')).toBe(false)
  })
})

describe('systemEnv', () => {
  test('carries the state dir and the claude config dir it is given', () => {
    const env = systemEnv(['spark'], '/state/x', '/cfg/y')
    expect(env.stateDir).toBe('/state/x')
    expect(env.claudeConfigDir).toBe('/cfg/y')
    expect(env.sessionNames).toEqual(['spark'])
  })
  test('the claude config dir defaults to CLAUDE_CONFIG_DIR, else ~/.claude', () => {
    const saved = process.env.CLAUDE_CONFIG_DIR
    try {
      process.env.CLAUDE_CONFIG_DIR = '/elsewhere/claude'
      expect(systemEnv([], '/s').claudeConfigDir).toBe('/elsewhere/claude')
      delete process.env.CLAUDE_CONFIG_DIR
      expect(systemEnv([], '/s').claudeConfigDir).toBe(join(systemEnv([], '/s').home, '.claude'))
    } finally { if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved }
  })
  test('isGitWorkTree: a folder in a repository is one, a folder outside any is not', () => {
    const env = systemEnv([], '/s')
    mkdirSync(join(dir, '.git')); mkdirSync(join(dir, 'sub'))
    expect(env.isGitWorkTree(join(dir, 'sub'))).toBe(true)
    expect(env.isGitWorkTree(outside)).toBe(false)
  })
  test('realpath resolves a symlink, and returns a path that does not exist as it is', () => {
    const env = systemEnv([], '/s')
    symlinkSync(outside, join(dir, 'l'))
    expect(env.realpath(join(dir, 'l'))).toBe(outside)
    expect(env.realpath(join(root, 'nope'))).toBe(join(root, 'nope'))
  })
})
