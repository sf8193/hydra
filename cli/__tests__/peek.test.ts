import { describe, test, expect, mock, beforeEach } from 'bun:test'

// Mock child_process before importing peek
const mockExecSync = mock(() => '')
const mockExecFileSync = mock(() => '')
mock.module('child_process', () => ({
  execSync: mockExecSync,
  execFileSync: mockExecFileSync,
}))

// Mock helpers to avoid real socket/tmux calls
const mockSendRequest = mock(async () => ({ ok: true as const, data: [] as Array<Record<string, string>> }))
const mockTmuxExists = mock(() => true)
const mockTmuxKill = mock(() => {})
mock.module('../helpers.js', () => ({
  resolveSocket: () => '/tmp/fake.sock',
  sendRequest: mockSendRequest,
  shq: (s: string) => "'" + s.replace(/'/g, "'\\''") + "'",
  tmuxExists: mockTmuxExists,
  tmuxKill: mockTmuxKill,
}))

// Now import peek (uses mocked modules)
const { peek } = await import('../peek.js')

// Capture process.exit calls
const mockExit = mock(() => { throw new Error('exit') })
process.exit = mockExit as any

const calls = () => mockExecSync.mock.calls as unknown as [string, ...unknown[]][]

beforeEach(() => {
  mockExecSync.mockClear()
  mockSendRequest.mockClear()
  mockTmuxExists.mockClear()
  mockTmuxKill.mockClear()
  mockExit.mockClear()
})

describe('peek', () => {
  describe('no live sessions', () => {
    test('exits cleanly when no sessions are live', async () => {
      mockSendRequest.mockResolvedValueOnce({ ok: true as const, data: [] as Array<Record<string, string>> })
      try { await peek([], undefined) } catch {}
      expect(mockExit).toHaveBeenCalledWith(0)
    })
  })

  describe('single session — direct attach', () => {
    test('attaches read-only to the sole session', async () => {
      mockSendRequest.mockResolvedValueOnce({
        ok: true as const,
        data: [{ name: 'spark', status: 'connected', description: 'test' }],
      })
      await peek([], undefined)
      const attachCall = calls().find(
        c => c[0].includes('attach-session') && c[0].includes("'spark'")
      )
      expect(attachCall).toBeDefined()
    })

    test('validates session name exists', async () => {
      mockSendRequest.mockResolvedValueOnce({
        ok: true as const,
        data: [{ name: 'spark', status: 'connected' }],
      })
      try { await peek(['drift'], undefined) } catch {}
      expect(mockExit).toHaveBeenCalledWith(1)
    })
  })

  describe('multiple sessions — window view', () => {
    test('creates hydra-peek session with windows for each', async () => {
      mockSendRequest.mockResolvedValueOnce({
        ok: true as const,
        data: [
          { name: 'spark', status: 'connected', description: 'alpha' },
          { name: 'pixel', status: 'connected', description: 'beta' },
          { name: 'nova', status: 'disconnected' },
        ],
      })
      await peek([], undefined)

      // Should kill existing peek session
      expect(mockTmuxKill).toHaveBeenCalledWith('hydra-peek')

      // Should create new session with first window
      const newSessionCall = calls().find(
        c => c[0].includes('new-session') && c[0].includes('hydra-peek')
      )
      expect(newSessionCall).toBeDefined()

      // Should link-window for each session
      const linkCalls = calls().filter(
        c => c[0].includes('link-window')
      )
      expect(linkCalls).toHaveLength(3) // spark + pixel + nova

      // Should attach to peek session
      const attachCall = calls().find(
        c => c[0].includes('attach-session') && c[0].includes('hydra-peek')
      )
      expect(attachCall).toBeDefined()
    })

    test('attaches to the peek session (not read-only, to allow navigation)', async () => {
      mockSendRequest.mockResolvedValueOnce({
        ok: true as const,
        data: [
          { name: 'spark', status: 'connected' },
          { name: 'pixel', status: 'connected' },
        ],
      })
      await peek([], undefined)

      const attachCall = calls().find(
        c => c[0].includes('attach-session') && c[0].includes('hydra-peek')
      )
      expect(attachCall).toBeDefined()
      // Should NOT be read-only — -r blocks ctrl+b n/p navigation
      expect(attachCall![0]).not.toContain(' -r')
    })

    test('does not modify global tmux key bindings', async () => {
      mockSendRequest.mockResolvedValueOnce({
        ok: true as const,
        data: [
          { name: 'spark', status: 'connected' },
          { name: 'pixel', status: 'connected' },
        ],
      })
      await peek([], undefined)

      const bindCalls = calls().filter(
        c => c[0].includes('bind-key')
      )
      expect(bindCalls).toHaveLength(0)
    })
  })


  describe('session filtering', () => {
    test('excludes dead sessions', async () => {
      mockSendRequest.mockResolvedValueOnce({
        ok: true as const,
        data: [
          { name: 'spark', status: 'connected' },
          { name: 'pixel', status: 'dead' },
        ],
      })
      await peek([], undefined)

      // Only spark is live — should direct-attach, not split
      const attachCall = calls().find(
        c => c[0].includes('attach-session') && c[0].includes("'spark'")
      )
      expect(attachCall).toBeDefined()
      // No hydra-peek session created
      expect(mockTmuxKill).not.toHaveBeenCalled()
    })
  })

  describe('named peek', () => {
    test('attaches to specific named session', async () => {
      mockSendRequest.mockResolvedValueOnce({
        ok: true as const,
        data: [
          { name: 'spark', status: 'connected' },
          { name: 'pixel', status: 'connected' },
        ],
      })
      await peek(['pixel'], undefined)

      const attachCall = calls().find(
        c => c[0].includes('attach-session') && c[0].includes("'pixel'")
      )
      expect(attachCall).toBeDefined()
      // Should NOT create hydra-peek
      expect(mockTmuxKill).not.toHaveBeenCalled()
    })
  })
})
