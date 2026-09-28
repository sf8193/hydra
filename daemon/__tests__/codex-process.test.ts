import { describe, expect, test } from 'bun:test'
import { homedir } from 'os'
import { join } from 'path'
import { codexHomeDir, codexPidPath, startCodexAppServer, stopCodexAppServer } from '../codex-process.js'

describe('durable Codex app-server process', () => {
  test('stores process identity inside the isolated agent home', () => {
    expect(codexHomeDir('ember')).toBe(`${process.env.HYDRA_CODEX_ROOT}/hydra-ember`)
    expect(codexPidPath('ember')).toBe(`${process.env.HYDRA_CODEX_ROOT}/hydra-ember/hydra-app-server.pid`)
  })

  test('without the test override, homes live under ~/.codex', () => {
    const saved = process.env.HYDRA_CODEX_ROOT
    delete process.env.HYDRA_CODEX_ROOT
    try {
      expect(codexHomeDir('ember')).toBe(join(homedir(), '.codex', 'hydra-ember'))
      expect(codexPidPath('ember')).toBe(join(homedir(), '.codex', 'hydra-ember', 'hydra-app-server.pid'))
    } finally { process.env.HYDRA_CODEX_ROOT = saved }
  })

  // test-setup.ts: tests can neither see real app-servers nor start one.
  test('under test, the Codex root is a temp dir and a real app-server is never started', () => {
    expect(() => startCodexAppServer({ homeName: 'x', cwd: '/tmp', logPath: '/tmp/x.log' })).toThrow(/refusing to start a real codex app-server/)
  })

  test('does not report a stop when no Hydra pid file exists', () => {
    expect(stopCodexAppServer(`missing-${Date.now()}`)).toBe(false)
  })
})
