// The folders a scoped session's listed servers write in (scoped-files.ts): where they are made, who owns them, and what a pre-existing
// parent does to that. TMPDIR is pointed at a fresh folder per test, so nothing here touches the real temp dir.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { makeServerTmpDirs, removeScopedFiles, serverTmpDir, serverTmpRoot } from '../scoped-files.js'

const SID = '11111111-1111-4111-8111-111111111111'
const SID2 = '22222222-2222-4222-8222-222222222222'
let base: string
let savedTmp: string | undefined
beforeEach(() => {
  savedTmp = process.env.TMPDIR
  base = mkdtempSync(join(tmpdir(), 'svtmp-'))
  process.env.TMPDIR = base
})
afterEach(() => {
  if (savedTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmp
  rmSync(base, { recursive: true, force: true })   // the one folder this test made
})

describe('the folders for a session\'s servers', () => {
  test('are made under the temp dir, one per server, each 0700, under a 0700 parent', () => {
    makeServerTmpDirs('ops', SID, ['datadog', 'other'])
    expect(serverTmpRoot()).toBe(join(base, 'hydra-scoped'))
    for (const server of ['datadog', 'other']) expect(statSync(serverTmpDir('ops', SID, server)).mode & 0o777).toBe(0o700)
    expect(statSync(serverTmpRoot()).mode & 0o777).toBe(0o700)
  })

  test('a parent that already exists with looser permissions is put back to 0700 (mkdir\'s mode applies to a new folder only)', () => {
    mkdirSync(serverTmpRoot(), { mode: 0o755 })
    expect(statSync(serverTmpRoot()).mode & 0o777).toBe(0o755)
    makeServerTmpDirs('ops', SID, ['datadog'])
    expect(statSync(serverTmpRoot()).mode & 0o777).toBe(0o700)
  })

  test('a parent that is a symlink is refused, with the folder named and the fix', () => {
    mkdirSync(join(base, 'elsewhere'))
    symlinkSync(join(base, 'elsewhere'), serverTmpRoot())
    expect(() => makeServerTmpDirs('ops', SID, ['datadog'])).toThrow(`${serverTmpRoot()} is not a plain folder, where the sandboxed servers' folders go: remove it`)
    expect(existsSync(join(base, 'elsewhere', `ops-${SID}`))).toBe(false)
  })

  test('a parent that is a file is refused with the plain message, not mkdir\'s', () => {
    writeFileSync(serverTmpRoot(), 'x')
    expect(() => makeServerTmpDirs('ops', SID, ['datadog'])).toThrow(`${serverTmpRoot()} is not a plain folder, where the sandboxed servers' folders go: remove it`)
  })

  test('a parent that is a dangling symlink is refused with the plain message, and nothing is made through it', () => {
    symlinkSync(join(base, 'nowhere'), serverTmpRoot())
    expect(() => makeServerTmpDirs('ops', SID, ['datadog'])).toThrow(`${serverTmpRoot()} is not a plain folder, where the sandboxed servers' folders go: remove it`)
    expect(existsSync(join(base, 'nowhere'))).toBe(false)
  })

  test('a second launch of the name replaces the first\'s folders (a resume or respawn starts with an empty folder: saved data does not survive)', () => {
    makeServerTmpDirs('ops', SID, ['datadog'])
    writeFileSync(join(serverTmpDir('ops', SID, 'datadog'), 'saved'), 'x')
    makeServerTmpDirs('ops', SID2, ['datadog'])
    expect(existsSync(serverTmpDir('ops', SID, 'datadog'))).toBe(false)
    expect(readdirSync(serverTmpDir('ops', SID2, 'datadog'))).toEqual([])
  })

  test('another session name\'s folders are left alone (`ops` is a prefix of `ops-eu`)', () => {
    makeServerTmpDirs('ops-eu', SID, ['datadog'])
    makeServerTmpDirs('ops', SID2, ['datadog'])
    expect(existsSync(serverTmpDir('ops-eu', SID, 'datadog'))).toBe(true)
  })

  test('the session\'s end removes its folders and only its own', () => {
    makeServerTmpDirs('ops', SID, ['datadog'])
    makeServerTmpDirs('desk', SID2, ['datadog'])
    removeScopedFiles({ tmuxName: 'ops', sessionId: SID }, true)
    expect(existsSync(serverTmpDir('ops', SID, 'datadog'))).toBe(false)
    expect(existsSync(serverTmpDir('desk', SID2, 'datadog'))).toBe(true)
  })
})
