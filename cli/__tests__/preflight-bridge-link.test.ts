import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { bridgeLinkVerdict } from '../lifecycle.js'

// The plugin cache's server.ts links to the checkout the daemon runs. A preflight run from another checkout (a worktree) must say
// so, and must never offer a command that re-points that link at itself.
let root: string
let installed: string   // the checkout the daemon runs
let worktree: string    // the checkout preflight runs from
let serverTs: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'preflight-link-'))
  installed = join(root, 'installed'); worktree = join(root, 'worktree')
  for (const d of [installed, worktree]) { mkdirSync(d); writeFileSync(join(d, 'bridge.ts'), '') }
  mkdirSync(join(root, 'cache'))
  serverTs = join(root, 'cache', 'server.ts')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('bridgeLinkVerdict', () => {
  test('linked to this checkout: ok', () => {
    symlinkSync(join(worktree, 'bridge.ts'), serverTs)
    expect(bridgeLinkVerdict('1.0.0', serverTs, join(worktree, 'bridge.ts'))).toEqual({ level: 'ok', msg: '1.0.0/server.ts links to bridge.ts' })
  })

  test('linked to another checkout that exists: this checkout is not the installed one, and no fix re-points the link', () => {
    symlinkSync(join(installed, 'bridge.ts'), serverTs)
    const v = bridgeLinkVerdict('1.0.0', serverTs, join(worktree, 'bridge.ts'))
    expect(v.level).toBe('warn')
    expect(v.msg).toContain('this checkout is not the installed one')
    expect(v.msg).toContain(join(installed, 'bridge.ts'))
    expect(v.msg).not.toMatch(/ln -s/)
    expect(v.msg).not.toContain(`'${join(worktree, 'bridge.ts')}'`)
  })

  test('a relative link to this checkout is this checkout', () => {
    symlinkSync(join('..', 'worktree', 'bridge.ts'), serverTs)
    expect(bridgeLinkVerdict('1.0.0', serverTs, join(worktree, 'bridge.ts')).level).toBe('ok')
  })

  test('a link that reaches this checkout by another path is this checkout', () => {
    symlinkSync(worktree, join(root, 'alias'))
    symlinkSync(join(root, 'alias', 'bridge.ts'), serverTs)
    expect(bridgeLinkVerdict('1.0.0', serverTs, join(worktree, 'bridge.ts')).level).toBe('ok')
  })

  test('a link to nothing, or a copy, or no file: fails, and the fix is the daemon relinking itself, not ln', () => {
    symlinkSync(join(root, 'gone', 'bridge.ts'), serverTs)
    const dangling = bridgeLinkVerdict('1.0.0', serverTs, join(worktree, 'bridge.ts'))
    rmSync(serverTs)
    writeFileSync(serverTs, 'a copy')
    const copy = bridgeLinkVerdict('1.0.0', serverTs, join(worktree, 'bridge.ts'))
    rmSync(serverTs)
    const absent = bridgeLinkVerdict('1.0.0', serverTs, join(worktree, 'bridge.ts'))
    for (const v of [dangling, copy, absent]) {
      expect(v.level).toBe('bad')
      expect(v.msg).toContain('start or restart the daemon')
      expect(v.msg).not.toMatch(/ln -s/)
    }
    expect(dangling.msg).toContain(join(root, 'gone', 'bridge.ts'))
    expect(copy.msg).toContain('a copy breaks every new bridge')
    expect(absent.msg).toContain('is missing')
  })
})
