import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { resolveBuilderChannel } from '../factory.js'
import { resolveForkSpawnCwd, buildWorktreePromptAppend } from '../session-lifecycle.js'

// Save and restore process.stderr.write so we suppress noise without leaking
let originalStderrWrite: typeof process.stderr.write

beforeEach(() => {
  originalStderrWrite = process.stderr.write
  process.stderr.write = (() => true) as any
})

afterEach(() => {
  process.stderr.write = originalStderrWrite
})

describe('resolveBuilderChannel', () => {
  test('uses anchorChannelId from registry when available', () => {
    const reg = { get: () => ({ anchorChannelId: 'channel-123' }) }
    const threads = { get: () => undefined }
    expect(resolveBuilderChannel('pm-1', 'thread-1', reg, threads)).toBe('channel-123')
  })

  test('falls back to parentChannelId from threadRegistry', () => {
    const reg = { get: () => ({ anchorChannelId: undefined }) }
    const threads = { get: () => ({ parentChannelId: 'channel-456' }) }
    expect(resolveBuilderChannel('pm-1', 'thread-1', reg, threads)).toBe('channel-456')
  })

  test('returns undefined when neither source has a channel', () => {
    const reg = { get: () => undefined }
    const threads = { get: () => undefined }
    expect(resolveBuilderChannel('pm-1', 'thread-1', reg, threads)).toBeUndefined()
  })

  test('never returns the PM thread ID itself', () => {
    const pmThreadId = 'thread-pm-999'
    // Simulate the old bug: registry has no anchorChannelId, threadRegistry has no parent
    const reg = { get: () => undefined }
    const threads = { get: () => undefined }
    const result = resolveBuilderChannel('pm-1', pmThreadId, reg, threads)
    // Must be undefined (falls back to DEFAULT_SESSION_CHANNEL), never the PM's thread
    expect(result).not.toBe(pmThreadId)
  })

  test('anchorChannelId takes priority over parentChannelId', () => {
    const reg = { get: () => ({ anchorChannelId: 'anchor-chan' }) }
    const threads = { get: () => ({ parentChannelId: 'parent-chan' }) }
    expect(resolveBuilderChannel('pm-1', 'thread-1', reg, threads)).toBe('anchor-chan')
  })
})

describe('resolveForkSpawnCwd', () => {
  const spawnCwd = '/Users/sam/trading'
  const worktreeCwd = '/Users/sam/trading/.worktrees/options_bot-vale'

  test('fork + worktree uses spawnCwd so --resume can find the conversation file', () => {
    expect(resolveForkSpawnCwd(true, true, spawnCwd, worktreeCwd)).toBe(spawnCwd)
  })

  test('fork without worktree uses effectiveCwd (no override needed)', () => {
    expect(resolveForkSpawnCwd(true, false, spawnCwd, spawnCwd)).toBe(spawnCwd)
  })

  test('non-fork worktree spawn uses worktree effectiveCwd directly', () => {
    expect(resolveForkSpawnCwd(false, true, spawnCwd, worktreeCwd)).toBe(worktreeCwd)
  })

  test('plain spawn uses effectiveCwd (same as spawnCwd)', () => {
    expect(resolveForkSpawnCwd(false, false, spawnCwd, spawnCwd)).toBe(spawnCwd)
  })
})

describe('buildWorktreePromptAppend', () => {
  const worktreePath = '/Users/sam/trading/.worktrees/options_bot-vale'

  test('fork + worktree returns cd instruction with absolute path', () => {
    const result = buildWorktreePromptAppend(true, worktreePath)
    expect(result).toContain(worktreePath)
    expect(result).toContain('cd there')
    expect(result).not.toBe('')
  })

  test('fork without worktree returns empty string', () => {
    expect(buildWorktreePromptAppend(true, undefined)).toBe('')
  })

  test('non-fork with worktree returns empty string (builder starts in worktree already)', () => {
    expect(buildWorktreePromptAppend(false, worktreePath)).toBe('')
  })

  test('plain spawn returns empty string', () => {
    expect(buildWorktreePromptAppend(false, undefined)).toBe('')
  })
})
