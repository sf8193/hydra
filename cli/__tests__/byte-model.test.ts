// The model main (the byte) starts with: hydra.toml's `[main] model`, else the spawn default. Every start reads it here.
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { byteModel, type HydraConfig } from '../helpers.js'
import { byteLaunch } from '../lifecycle.js'

let stateDir: string
let savedModel: string | undefined
const at = () => ({ stateDir, platform: 'discord', configDir: join(stateDir, 'claude') })
const toml = (text: string) => writeFileSync(join(stateDir, 'hydra.toml'), text)

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'hydra-byte-model-'))
  savedModel = process.env.HYDRA_MODEL
  process.env.HYDRA_MODEL = 'claude-sonnet-5-5[1m]'
})
afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true })
  if (savedModel === undefined) delete process.env.HYDRA_MODEL
  else process.env.HYDRA_MODEL = savedModel
})

test('[main] model wins over HYDRA_MODEL, which stays the spawn default only', () => {
  toml('[main]\nmodel = "claude-opus-5-5[1m]"\n')
  expect(byteModel(at())).toEqual({ model: 'claude-opus-5-5[1m]', from: '[main] model in hydra.toml' })
})

test('[main] model resolves as a specialist\'s model does: an alias is its full ID, a bare known ID gets its 1M window', () => {
  toml('[main]\nmodel = "opus"\n')
  expect(byteModel(at()).model).toBe('claude-opus-5-5[1m]')
  toml('[main]\nmodel = "claude-opus-5-5"\n')
  expect(byteModel(at()).model).toBe('claude-opus-5-5[1m]')
})

test('no hydra.toml, or one without [main] model: the spawn default, as before', () => {
  expect(byteModel(at())).toEqual({ model: 'claude-sonnet-5-5[1m]', from: 'HYDRA_MODEL' })
  toml('[main]\n')
  expect(byteModel(at())).toEqual({ model: 'claude-sonnet-5-5[1m]', from: 'HYDRA_MODEL' })
  delete process.env.HYDRA_MODEL
  expect(byteModel(at()).from).toBe('the default')
})

test('a hydra.toml that does not load still gives its [main] model, read on its own, as the daemon keeps its last good config', () => {
  toml('[main]\nmodel = "opus"\n[specialists.ops]\nbogus = 1\n')
  expect(byteModel(at())).toEqual({ model: 'claude-opus-5-5[1m]', from: '[main] model in hydra.toml' })
})

test('an unreadable [main] model falls back to the spawn default and says why; a broken file with no [main] says nothing', () => {
  toml('[main]\nmodel = 5\n')
  const r = byteModel(at())
  expect(r.model).toBe('claude-sonnet-5-5[1m]')
  expect(r.problem).toContain('main.model: must be a non-empty string')
  toml('[main\nmodel = "opus"\n')
  expect(byteModel(at()).problem).toBeUndefined()
  toml('[specialists.ops]\nbogus = 1\n')
  expect(byteModel(at())).toEqual({ model: 'claude-sonnet-5-5[1m]', from: 'HYDRA_MODEL' })
})

test('startByte\'s launch command carries that model', () => {
  toml('[main]\nmodel = "opus"\n')
  mkdirSync(join(stateDir, 'mods'))
  const cfg = { ...at(), byteCwd: '/cwd', sockPath: join(stateDir, 'daemon.sock') } as HydraConfig
  const { model, command } = byteLaunch(cfg, 'hello', '')
  expect(model.model).toBe('claude-opus-5-5[1m]')
  expect(command).toContain("claude --model 'claude-opus-5-5[1m]' --channels")
})

test('start-byte.sh holds no model of its own: it starts main through the CLI\'s startByte', () => {
  const script = readFileSync(join(import.meta.dir, '..', '..', 'start-byte.sh'), 'utf8')
  expect(script).not.toContain('--model')
  expect(script).toContain('startByte')
})
