import { describe, expect, test } from 'bun:test'
import { homedir, tmpdir } from 'os'
import { codexHomeDir, codexPidPath, startCodexAppServer, stopCodexAppServer } from '../codex-process.js'

describe('durable Codex app-server process', () => {
  test('stores process identity inside the isolated agent home', () => {
    expect(codexHomeDir('ember')).toBe(`${process.env.HYDRA_CODEX_ROOT}/hydra-ember`)
    expect(codexPidPath('ember')).toBe(`${process.env.HYDRA_CODEX_ROOT}/hydra-ember/hydra-app-server.pid`)
  })

  // test-setup.ts: tests can neither see real app-servers nor start one.
  test('under test, the Codex root is a temp dir and a real app-server is never started', () => {
    expect(process.env.HYDRA_CODEX_ROOT!.startsWith(tmpdir()) || process.env.HYDRA_CODEX_ROOT!.includes('/hydra-test-')).toBe(true)
    expect(codexHomeDir('x').startsWith(`${homedir()}/.codex`)).toBe(false)
    expect(() => startCodexAppServer({ homeName: 'x', cwd: '/tmp', logPath: '/tmp/x.log' })).toThrow(/refusing to start a real codex app-server/)
  })

  test('does not report a stop when no Hydra pid file exists', () => {
    expect(stopCodexAppServer(`missing-${Date.now()}`)).toBe(false)
  })
})
