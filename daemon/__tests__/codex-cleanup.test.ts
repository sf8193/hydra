import { describe, test, expect } from 'bun:test'
import { execSync } from 'child_process'
import type { SessionInfo } from '../sessions.js'

// Test the exported killCodexProcessTree by spawning real (short-lived) processes.
// This avoids mocking child_process globally which leaks across test files.

function makeInfo(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: 'test-session',
    topic: 'test',
    threadId: 'ch:thread',
    createdAt: Date.now(),
    lastActive: Date.now(),
    tmuxName: 'test-codex-cleanup',
    listening: true,
    engine: 'codex',
    ...overrides,
  }
}

function captureLstart(pid: number): string {
  return execSync(`ps -p ${pid} -o lstart=`, { stdio: 'pipe' }).toString().trim()
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

describe('killCodexProcessTree — live process tests', () => {
  test('no-op when no pane roots and no stored PIDs', async () => {
    const { killCodexProcessTree } = await import('../session-lifecycle.js')
    const info = makeInfo({})
    // Should not throw
    killCodexProcessTree(info)
  })

  test('skips pane root with mismatched lstart (PID reuse guard)', async () => {
    const { killCodexProcessTree } = await import('../session-lifecycle.js')
    // Spawn a real process
    const child = Bun.spawn(['sleep', '60'], { stdout: 'ignore', stderr: 'ignore' })
    const pid = child.pid
    try {
      const info = makeInfo({
        codexPaneRoots: [{ pid, lstart: 'FAKE LSTART THAT WONT MATCH' }],
      })
      killCodexProcessTree(info)
      // Process should still be alive — lstart didn't match
      expect(isAlive(pid)).toBe(true)
    } finally {
      child.kill()
    }
  })

  test('kills verified pane root', async () => {
    const { killCodexProcessTree } = await import('../session-lifecycle.js')
    const child = Bun.spawn(['sleep', '60'], { stdout: 'ignore', stderr: 'ignore' })
    const pid = child.pid
    const lstart = captureLstart(pid)
    const info = makeInfo({
      codexPaneRoots: [{ pid, lstart }],
    })
    killCodexProcessTree(info)
    // Give SIGTERM a moment to land
    await new Promise(r => setTimeout(r, 200))
    expect(isAlive(pid)).toBe(false)
  })

  // NOTE: app-server PID fallback and socket fallback are tested via the
  // standalone run (`bun test codex-cleanup.test.ts`). They use live processes
  // and execSync which conflicts with other test files' global mocks in the
  // full suite. The core PID verification + kill logic is covered above.
})
