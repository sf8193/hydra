import { expect, test } from 'bun:test'
import { execFileSync } from 'child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CodexEngineAdapter } from '../engines/codex-engine-adapter.js'

// Real-tmux tests. CI runs this file in its own `bun test` process:
// cli/__tests__/peek.test.ts leaks a child_process mock into a shared process.
const hasTmux = Bun.spawnSync(['tmux', '-V']).exitCode === 0
const mocked = 'mock' in execFileSync

async function withIsolatedPath(fakes: Record<string, string>, fn: (dir: string) => unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'hydra-tmux-'))
  const saved = { TMUX_TMPDIR: process.env.TMUX_TMPDIR, TMUX: process.env.TMUX, PATH: process.env.PATH }
  for (const [name, body] of Object.entries(fakes)) {
    writeFileSync(join(dir, name), body)
    chmodSync(join(dir, name), 0o755)
  }
  process.env.TMUX_TMPDIR = dir
  delete process.env.TMUX
  process.env.PATH = `${dir}:${saved.PATH}`
  try { await fn(dir) } finally {
    // Explicit socket: never touch the developer's real tmux server.
    try { execFileSync('tmux', ['-S', join(dir, `tmux-${process.getuid!()}`, 'default'), 'kill-server'], { stdio: 'pipe' }) } catch {}
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    rmSync(dir, { recursive: true, force: true })
  }
}

// F3: the TUI window must be current, so callers targeting the bare session hit it.
test.skipIf(!hasTmux || mocked)('surface leaves hydra-chat as the current window', async () => {
  await withIsolatedPath({ codex: '#!/bin/sh\nexec sleep 30\n' }, dir => {
    const adapter = new CodexEngineAdapter({ isConnected: () => true } as any)
    expect(adapter.surface({ sessionId: 's', tmuxName: 'r1-surface', codexThreadId: 't' } as any)).toBe('r1-surface:hydra-chat')
    const sock = join(dir, `tmux-${process.getuid!()}`, 'default')
    const current = execFileSync('tmux', ['-S', sock, 'display-message', '-p', '-t', 'r1-surface', '#{window_name}'],
      { encoding: 'utf8', stdio: 'pipe' }).trim()
    expect(current).toBe('hydra-chat')
    const windows = execFileSync('tmux', ['-S', sock, 'list-windows', '-t', 'r1-surface', '-F', '#{window_name}'],
      { encoding: 'utf8', stdio: 'pipe' }).trim().split('\n')
    expect(adapter.surface({ sessionId: 's', tmuxName: 'r1-surface', codexThreadId: 't' } as any)).toBe('r1-surface:hydra-chat')
    expect(execFileSync('tmux', ['-S', sock, 'list-windows', '-t', 'r1-surface', '-F', '#{window_name}'],
      { encoding: 'utf8', stdio: 'pipe' }).trim().split('\n')).toEqual(windows)
  })
})

// A broken tmux must never fail a launch: the surface is repaired on turn completion.
test.skipIf(mocked)('launch resolves when every tmux call fails', async () => {
  await withIsolatedPath({ tmux: '#!/bin/sh\nexit 1\n' }, async () => {
    let connected = false
    const engine = {
      queueTurn: () => true,
      connect: async () => { connected = true; return { threadId: 'thread-1', model: 'm' } },
      isConnected: () => connected,
    }
    const adapter = new CodexEngineAdapter(engine as any) as any
    adapter.startAppServer = () => '/tmp/spawn.log'
    const result = await adapter.launch({ sessionId: 's1', tmuxName: 'codex-t', cwd: '/tmp', originalCwd: '/tmp', model: 'm', prompt: 'hi' })
    expect(result).toMatchObject({ provider: 'codex', codexThreadId: 'thread-1' })
  })
})
