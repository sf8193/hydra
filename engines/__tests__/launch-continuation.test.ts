import { describe, expect, test } from 'bun:test'
import { launchContinuationFrom, type LaunchInput } from '../engine-adapter.js'
import { ClaudeEngine } from '../claude-engine.js'
import { CodexEngineAdapter } from '../codex-engine-adapter.js'
import { OmpEngine } from '../omp-engine.js'
import { AgyEngine } from '../agy-engine.js'

describe('launchContinuationFrom', () => {
  test('returns undefined when no continuation option is set', () => {
    expect(launchContinuationFrom(undefined)).toBeUndefined()
    expect(launchContinuationFrom({})).toBeUndefined()
  })

  test('maps each single continuation option to its discriminated variant', () => {
    expect(launchContinuationFrom({ resumeFrom: 'C-1' })).toEqual({ kind: 'resume-claude', claudeSessionId: 'C-1' })
    expect(launchContinuationFrom({ resumeCodex: { threadId: 'T-1', homeName: 'h1' } })).toEqual({ kind: 'resume-codex', threadId: 'T-1', homeName: 'h1' })
    expect(launchContinuationFrom({ resumeSession: { fromSessionId: 'S-1' } })).toEqual({ kind: 'resume-session', fromSessionId: 'S-1' })
    expect(launchContinuationFrom({ forkFrom: { claudeSessionId: 'C-2', parentName: 'p' } })).toEqual({ kind: 'fork-claude', claudeSessionId: 'C-2' })
    expect(launchContinuationFrom({ forkFrom: { codexThreadId: 'T-2', parentName: 'p' } })).toEqual({ kind: 'fork-codex', codexThreadId: 'T-2' })
  })

  test('rejects conflicting or malformed continuation combinations', () => {
    expect(() => launchContinuationFrom({ resumeFrom: 'C-1', forkFrom: { claudeSessionId: 'C-2', parentName: 'p' } }))
      .toThrow('conflicting launch continuations: resume-claude, fork-claude')
    expect(() => launchContinuationFrom({ resumeCodex: { threadId: 'T-1', homeName: 'h' }, resumeSession: { fromSessionId: 'S-1' } }))
      .toThrow('conflicting launch continuations: resume-codex, resume-session')
    expect(() => launchContinuationFrom({ forkFrom: { claudeSessionId: 'C-1', codexThreadId: 'T-1', parentName: 'p' } }))
      .toThrow('cannot combine claudeSessionId and codexThreadId in forkFrom')
    expect(() => launchContinuationFrom({ forkFrom: { parentName: 'p' } }))
      .toThrow('forkFrom must name either claudeSessionId or codexThreadId')
  })
})

describe('engine adapters fail closed on foreign LaunchContinuation kinds', () => {
  const base: LaunchInput = {
    sessionId: 'lc-s', tmuxName: 'lc-t', cwd: '/tmp', originalCwd: '/tmp', model: 'claude-opus-4-1', prompt: 'hi',
  }

  test('ClaudeEngine rejects codex and session continuations', async () => {
    const claude = new ClaudeEngine({} as any)
    await expect(claude.launch({ ...base, continuation: { kind: 'resume-codex', threadId: 'T-1', homeName: 'h' } }))
      .rejects.toThrow('claude engine: unsupported launch continuation "resume-codex"')
    await expect(claude.launch({ ...base, continuation: { kind: 'fork-codex', codexThreadId: 'T-1' } }))
      .rejects.toThrow('claude engine: unsupported launch continuation "fork-codex"')
    await expect(claude.launch({ ...base, continuation: { kind: 'resume-session', fromSessionId: 'S-1' } }))
      .rejects.toThrow('claude engine: unsupported launch continuation "resume-session"')
  })

  test('CodexEngineAdapter rejects claude and session continuations', async () => {
    const codex = new CodexEngineAdapter({} as any, {} as any, {} as any, { values: () => new Map().values(), get: () => undefined })
    await expect(codex.launch({ ...base, continuation: { kind: 'resume-claude', claudeSessionId: 'C-1' } }))
      .rejects.toThrow('codex engine: unsupported launch continuation "resume-claude"')
    await expect(codex.launch({ ...base, continuation: { kind: 'fork-claude', claudeSessionId: 'C-1' } }))
      .rejects.toThrow('codex engine: unsupported launch continuation "fork-claude"')
    await expect(codex.launch({ ...base, continuation: { kind: 'resume-session', fromSessionId: 'S-1' } }))
      .rejects.toThrow('codex engine: unsupported launch continuation "resume-session"')
  })

  test('OmpEngine rejects claude and codex continuations', async () => {
    const omp = new OmpEngine({} as any)
    await expect(omp.launch({ ...base, continuation: { kind: 'resume-claude', claudeSessionId: 'C-1' } }))
      .rejects.toThrow('omp engine: unsupported launch continuation "resume-claude"')
    await expect(omp.launch({ ...base, continuation: { kind: 'fork-claude', claudeSessionId: 'C-1' } }))
      .rejects.toThrow('omp engine: unsupported launch continuation "fork-claude"')
    await expect(omp.launch({ ...base, continuation: { kind: 'resume-codex', threadId: 'T-1', homeName: 'h' } }))
      .rejects.toThrow('omp engine: unsupported launch continuation "resume-codex"')
  })

  test('AgyEngine rejects claude and codex continuations', async () => {
    const agy = new AgyEngine({} as any)
    await expect(agy.launch({ ...base, continuation: { kind: 'resume-claude', claudeSessionId: 'C-1' } }))
      .rejects.toThrow('agy engine: unsupported launch continuation "resume-claude"')
    await expect(agy.launch({ ...base, continuation: { kind: 'fork-codex', codexThreadId: 'T-1' } }))
      .rejects.toThrow('agy engine: unsupported launch continuation "fork-codex"')
  })
})
