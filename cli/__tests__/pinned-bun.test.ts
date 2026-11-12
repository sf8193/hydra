import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pinnedBun, pinnedBunVersion, type BunIO } from '../helpers.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hydra-bun-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const pin = (body: string) => writeFileSync(join(dir, '.tool-versions'), body)
const io = (over: Partial<BunIO> = {}): BunIO => ({
  version: '1.3.14', execPath: '/caller/bun', asdfDir: '/asdf',
  exists: () => false, which: () => '/path/bun', ...over,
})

test('the repo pins exactly one bun, in .tool-versions, the file CI reads', () => {
  const root = join(import.meta.dir, '..', '..')
  expect(pinnedBunVersion(root)).toMatch(/^\d+\.\d+\.\d+$/)
  expect(readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8')).toContain('bun-version-file: .tool-versions')
})

test('reads the bun line among other tools', () => {
  pin('nodejs 24.8.0\nbun   1.4.4 # pinned\n')
  expect(pinnedBunVersion(dir)).toBe('1.4.4')
})

test('the caller already running the pinned bun is the answer', () => {
  pin('bun 1.4.4\n')
  expect(pinnedBun(dir, io({ version: '1.4.4' }))).toEqual({ path: '/caller/bun' })
})

test('otherwise the pinned asdf install, whatever bun the caller runs', () => {
  pin('bun 1.4.4\n')
  const installed = '/asdf/installs/bun/1.4.4/bin/bun'
  expect(pinnedBun(dir, io({ exists: p => p === installed }))).toEqual({ path: installed })
})

test('a missing pinned bun falls back to the bun on PATH, with the reason', () => {
  pin('bun 1.4.4\n')
  const bun = pinnedBun(dir, io())
  expect(bun.path).toBe('/path/bun')
  expect(bun.fallback).toContain('asdf install bun 1.4.4')
})

test('no pin falls back too, and says so', () => {
  const bun = pinnedBun(dir, io({ which: () => null }))
  expect(bun.path).toBe('bun')
  expect(bun.fallback).toContain('pins no bun')
})
