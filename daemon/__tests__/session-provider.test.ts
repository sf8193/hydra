import { describe, expect, test } from 'bun:test'
import { codexForkSpawnOptions, ensureCodexInteractiveSurface, providerFor, providerForEntry } from '../session-provider.js'

describe('session providers', () => {
  test('defaults legacy sessions to Claude', () => {
    expect(providerFor().id).toBe('claude')
    expect(providerForEntry(undefined).id).toBe('claude')
  })

  test('recognizes persisted Codex identity from legacy entries', () => {
    expect(providerForEntry({ codexThreadId: 'thread-1' } as any).id).toBe('codex')
  })

  test('normalizes provider-specific UI targets and capabilities', () => {
    const info = { tmuxName: 'flint' } as any
    expect(providerFor('claude').uiTarget(info)).toBe('flint')
    expect(providerFor('codex').uiTarget(info)).toBe('flint:hydra-chat')
    expect(providerFor('codex').capabilities).toMatchObject({ nativeResume: true, dynamicTools: true, structuredUsage: true })
  })

  test('uses structured context telemetry for Codex', () => {
    const info = { tmuxName: 'flint', contextUsage: { usedTokens: 120, contextWindow: 1000, percent: 12, updatedAt: 1 } } as any
    expect(providerFor('codex').contextPercent(info)).toBe('12%')
  })

  test('carries the source CODEX_HOME into native fork planning', () => {
    expect(codexForkSpawnOptions({ threadId: 'saved-thread', homeName: 'original-home' }, 'parent'))
      .toMatchObject({ engine: 'codex', forkFrom: {
        codexThreadId: 'saved-thread', codexHomeName: 'original-home', parentName: 'parent',
      } })
  })

  test('rebuilds a missing tmux container around a connected Codex engine', () => {
    let hasSession = false
    const calls: string[][] = []
    const info = {
      sessionId: 'session-1', tmuxName: 'drift', codexThreadId: 'thread-1', codexHomeName: 'drift',
    } as any

    const repaired = ensureCodexInteractiveSurface(info, {
      isConnected: () => true,
      hasSession: () => hasSession,
      tmux: args => {
        calls.push(args)
        if (args[0] === 'new-session') hasSession = true
        if (args[0] === 'list-windows') return 'hydra-anchor\n'
        return ''
      },
    })

    expect(repaired).toBe(true)
    expect(calls.map(call => call[0])).toEqual(['new-session', 'list-windows', 'new-window'])
    expect(calls[0]).toContain('hydra-anchor')
    expect(calls[2]).toContain('hydra-chat')
    expect(calls[2].at(-1)).toContain("codex resume 'thread-1'")
  })

  test('does not fabricate tmux state when the Codex engine is disconnected', () => {
    const calls: string[][] = []
    const repaired = ensureCodexInteractiveSurface({
      sessionId: 'session-1', tmuxName: 'drift', codexThreadId: 'thread-1',
    } as any, {
      isConnected: () => false,
      hasSession: () => false,
      tmux: args => { calls.push(args); return '' },
    })
    expect(repaired).toBe(false)
    expect(calls).toEqual([])
  })
})
