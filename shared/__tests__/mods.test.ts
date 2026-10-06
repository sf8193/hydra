import { test, expect } from 'bun:test'
import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { syncMods, modsExport } from '../mods.js'

function repo(): string {
  const r = mkdtempSync(join(tmpdir(), 'mods-repo-'))
  mkdirSync(join(r, 'mod', 'hooks'), { recursive: true })
  writeFileSync(join(r, 'mod', 'hooks', 'register.ts'), 'v1')
  return r
}

test('copies mod/ as hydra and each mods.local dir under its own name', () => {
  const r = repo(), state = mkdtempSync(join(tmpdir(), 'mods-state-'))
  mkdirSync(join(r, 'mods.local', 'guards', 'hooks'), { recursive: true })
  writeFileSync(join(r, 'mods.local', 'guards', 'hooks', 'register.ts'), 'g')
  writeFileSync(join(r, 'mods.local', 'README'), 'not a mod')
  expect(syncMods(r, state).sort()).toEqual(['guards', 'hydra'])
  expect(readFileSync(join(state, 'mods', 'hydra', 'hooks', 'register.ts'), 'utf8')).toBe('v1')
  expect(readFileSync(join(state, 'mods', 'guards', 'hooks', 'register.ts'), 'utf8')).toBe('g')
})

test('a resync updates copies and removes a mod whose source is gone', () => {
  const r = repo(), state = mkdtempSync(join(tmpdir(), 'mods-state-'))
  mkdirSync(join(r, 'mods.local', 'old'), { recursive: true })
  syncMods(r, state)
  writeFileSync(join(r, 'mod', 'hooks', 'register.ts'), 'v2')
  rmSync(join(r, 'mods.local', 'old'), { recursive: true })
  expect(syncMods(r, state)).toEqual(['hydra'])
  expect(readFileSync(join(state, 'mods', 'hydra', 'hooks', 'register.ts'), 'utf8')).toBe('v2')
  expect(existsSync(join(state, 'mods', 'old'))).toBe(false)
})

test('the export lists every synced copy, shell-quoted', () => {
  const r = repo(), state = mkdtempSync(join(tmpdir(), "mods it's-"))
  mkdirSync(join(r, 'mods.local', 'guards'), { recursive: true })
  syncMods(r, state)
  const line = modsExport(state)
  const value = Bun.spawnSync(['sh', '-c', `${line} && printf %s "$CLAUDE_CODE_PLUGIN_DIRS"`]).stdout.toString()
  expect(value.split(':').sort()).toEqual([join(state, 'mods', 'guards'), join(state, 'mods', 'hydra')])
})

test('mods.local: follows a symlinked dir; skips `hydra` and names with a colon', () => {
  const r = repo(), state = mkdtempSync(join(tmpdir(), 'mods-state-')), elsewhere = mkdtempSync(join(tmpdir(), 'mods-ext-'))
  mkdirSync(join(r, 'mods.local', 'hydra'), { recursive: true })
  writeFileSync(join(r, 'mods.local', 'hydra', 'x'), 'LOCAL')
  mkdirSync(join(r, 'mods.local', 'a:b'), { recursive: true })
  symlinkSync(elsewhere, join(r, 'mods.local', 'linked'))
  expect(syncMods(r, state).sort()).toEqual(['hydra', 'linked'])
  expect(existsSync(join(state, 'mods', 'hydra', 'x'))).toBe(false)
})

test('a file deleted from a mod is gone from its copy after a resync', () => {
  const r = repo(), state = mkdtempSync(join(tmpdir(), 'mods-state-'))
  writeFileSync(join(r, 'mod', 'hooks', 'old.ts'), 'x')
  syncMods(r, state)
  rmSync(join(r, 'mod', 'hooks', 'old.ts'))
  syncMods(r, state)
  expect(existsSync(join(state, 'mods', 'hydra', 'hooks', 'old.ts'))).toBe(false)
})
