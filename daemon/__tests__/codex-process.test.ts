import { describe, expect, test } from 'bun:test'
import { codexHomeDir, codexPidPath, stopCodexAppServer } from '../codex-process.js'

describe('durable Codex app-server process', () => {
  test('stores process identity inside the isolated agent home', () => {
    expect(codexHomeDir('ember')).toEndWith('/.codex/hydra-ember')
    expect(codexPidPath('ember')).toEndWith('/.codex/hydra-ember/hydra-app-server.pid')
  })

  test('does not report a stop when no Hydra pid file exists', () => {
    expect(stopCodexAppServer(`missing-${Date.now()}`)).toBe(false)
  })
})
