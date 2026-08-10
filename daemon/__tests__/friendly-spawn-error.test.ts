import { describe, it, expect } from 'bun:test'
import { friendlySpawnError } from '../session-lifecycle.js'

describe('friendlySpawnError', () => {
  it('matches tmux no server running', () => {
    const result = friendlySpawnError(new Error('tmux: no server running on /tmp/tmux-1000/default'))
    expect(result).toContain('tmux is not running')
    expect(result).toContain('tmux new-session -d')
  })

  it('matches tmux error connecting', () => {
    const result = friendlySpawnError(new Error('error connecting to /tmp/tmux-1000/default (No such file or directory)'))
    expect(result).toContain('tmux is not running')
  })

  it('matches ENOENT for claude', () => {
    const result = friendlySpawnError(new Error('ENOENT: no such file or directory, spawn claude'))
    expect(result).toContain('Claude CLI not found')
    expect(result).toContain('PATH')
  })

  it('matches worktree already exists', () => {
    const result = friendlySpawnError(new Error("failed to create worktree: 'wt/cedar' already exists"))
    expect(result).toContain('already exists')
    expect(result).toContain('git worktree list')
  })

  it('matches generic failed to create worktree', () => {
    const result = friendlySpawnError(new Error('failed to create worktree: some git error'))
    expect(result).toContain('git worktree list')
    expect(result).toContain('different session name')
  })

  it('matches permission denied (EACCES)', () => {
    const result = friendlySpawnError(new Error('EACCES: permission denied, mkdir /some/path'))
    expect(result).toContain('Permission denied')
    expect(result).toContain('file permissions')
  })

  it('matches permission denied (lowercase)', () => {
    const result = friendlySpawnError(new Error('failed to spawn tmux session: permission denied'))
    expect(result).toContain('Permission denied')
  })

  it('matches no available session names', () => {
    const result = friendlySpawnError(new Error('No available session names'))
    expect(result).toContain('No available session names')
    expect(result).toContain('/kill')
  })

  it('uses default fallback for unknown errors', () => {
    const result = friendlySpawnError(new Error('something totally unexpected happened'))
    expect(result).toContain('Spawn failed:')
    expect(result).toContain('something totally unexpected happened')
    expect(result).toContain('/health')
  })

  it('handles non-Error objects', () => {
    const result = friendlySpawnError('plain string error')
    expect(result).toContain('Spawn failed:')
    expect(result).toContain('plain string error')
  })

  it('handles null/undefined-ish values', () => {
    const result = friendlySpawnError(null)
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })
})
