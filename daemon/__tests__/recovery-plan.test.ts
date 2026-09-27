// EngineAdapter.recoveryPlan (S8): pure, spawns nothing. Ported from
// fork-strategy.test.ts (canNativeFork); the cross-engine half now lives in
// handleForkIntercept (thread-recovery.test.ts "cross-engine: continuation…").

import { describe, expect, test } from 'bun:test'
import { ClaudeEngine } from '../engines/claude-engine.js'
import { CodexEngineAdapter } from '../engines/codex-engine-adapter.js'

const claude = new ClaudeEngine({} as any)
const codex = new CodexEngineAdapter({} as any, {} as any)

describe('native fork (ported from canNativeFork)', () => {
  test('allows same-engine forks with matching native history', () => {
    expect(codex.recoveryPlan({ tmuxName: 'p', codexThreadId: 'thr_parent' }).fork).not.toBeNull()
    expect(claude.recoveryPlan({ tmuxName: 'p', claudeSessionId: 'claude-parent' }).fork).not.toBeNull()
  })

  test('the other engine\'s id is not native history', () => {
    expect(codex.recoveryPlan({ tmuxName: 'p', claudeSessionId: 'claude-parent' }).fork).toBeNull()
    expect(claude.recoveryPlan({ tmuxName: 'p', codexThreadId: 'thr_parent' }).fork).toBeNull()
  })
})

describe('recoveryPlan', () => {
  test('Claude: resume awaits the bridge; fork from the session id', () => {
    expect(claude.recoveryPlan({ tmuxName: 'dead', claudeSessionId: 'C' })).toEqual({
      generic: true,
      resume: { kind: 'await-bridge', resumeFrom: 'C' },
      fork: { claudeSessionId: 'C', parentName: 'dead' },
    })
  })

  test('Codex: resume at launch in the original home; fork with thread and home', () => {
    expect(codex.recoveryPlan({ tmuxName: 'dead', codexThreadId: 'T', codexHomeName: 'home' })).toEqual({
      generic: false,
      resume: { kind: 'at-launch', resumeCodex: { threadId: 'T', homeName: 'home' } },
      fork: { codexThreadId: 'T', codexHomeName: 'home', parentName: 'dead' },
    })
  })

  test('Codex home defaults to the tmux name', () => {
    const p = codex.recoveryPlan({ tmuxName: 'dead', codexThreadId: 'T' })
    expect(p.resume).toEqual({ kind: 'at-launch', resumeCodex: { threadId: 'T', homeName: 'dead' } })
    expect(p.fork?.codexHomeName).toBe('dead')
  })

  test('no native id → nothing to resume or fork', () => {
    expect(claude.recoveryPlan({ tmuxName: 'dead' })).toEqual({ generic: true, resume: null, fork: null })
    expect(codex.recoveryPlan({ tmuxName: 'dead' })).toEqual({ generic: false, resume: null, fork: null })
  })

  // PINNED R9 (PR-IDENT): Codex ignores a stray Claude id, as thread.ts did before S8.
  test('PINNED R9: Codex record with only a claudeSessionId → no plan', () => {
    expect(codex.recoveryPlan({ tmuxName: 'dead', claudeSessionId: 'C' })).toEqual({ generic: false, resume: null, fork: null })
  })
})
